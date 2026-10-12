import { describe, it, expect, beforeAll } from "vitest";
import fs from "node:fs";
import { EDITOR, freshDb, getDb, getStorage, sampleVideo, setupProjectWithVideo, uploadFile } from "./helpers";
import { createProject } from "@/lib/services/projects";
import { assertVideoInScope, createReviewLink, resolveReviewToken, updateReviewLink } from "@/lib/services/review-links";
import { createComment, listComments, setCommentStatus, upsertGuestIdentity } from "@/lib/services/comments";
import { buildReviewView } from "@/lib/services/review-view";
import { abortUpload, completeUpload, uploadStatus } from "@/lib/services/videos";
import { HttpError } from "@/lib/http";

const tokenOf = (url: string | null) => url!.split("/r/")[1]!;

async function expectHttp(p: Promise<unknown>, status: number) {
  const err = await p.then(
    () => null,
    (e) => e,
  );
  expect(err).toBeInstanceOf(HttpError);
  expect((err as HttpError).status).toBe(status);
  return err as HttpError;
}

describe("projects, uploads and guest review", () => {
  let projectId: string, videoId: string, versionId: string;

  beforeAll(async () => {
    await freshDb();
    ({ projectId, videoId, versionId } = await setupProjectWithVideo("Acme Launch"));
  });

  it("(1) editor creates a project and uploads a video directly to storage", async () => {
    const view = await buildReviewView(videoId, { isEditor: true, canComment: true });
    expect(view.video.project_id).toBe(projectId);
    const v = view.versions[0]!;
    expect(v.status).toBe("ready");
    expect(v.version_number).toBe(1);
    expect(v.size_bytes).toBe(fs.statSync(sampleVideo()).size);
    expect(v.width).toBe(640);
    expect(v.height).toBe(360);
    expect(v.playback_url).toMatch(/\/api\/storage\/local\?op=get&.*sig=/);
    const db = await getDb();
    const [row] = await db.query<{ storage_key: string }>("select storage_key from video_versions where id = $1", [versionId]);
    expect((await getStorage().head(row!.storage_key))?.size).toBe(v.size_bytes);
  });

  it("(2)(7) valid review link grants guest access; invalid or out-of-scope access is refused", async () => {
    const link = await createReviewLink({ projectId, videoId, canComment: true }, EDITOR);
    expect(link.url).toMatch(/\/r\/[A-Za-z0-9_-]{43}$/);
    const resolved = await resolveReviewToken(tokenOf(link.url));
    expect(resolved.can_comment).toBe(true);
    const guestView = await buildReviewView(videoId, { isEditor: false, canComment: resolved.can_comment });
    expect(guestView.permissions.is_editor).toBe(false);
    expect(guestView.versions[0]!.playback_url).toBeTruthy();

    // tokens are stored hashed, never raw
    const db = await getDb();
    const [stored] = await db.query<{ token_hash: string; token_ciphertext: string }>("select token_hash, token_ciphertext from review_links where id = $1", [link.id]);
    expect(stored!.token_hash).not.toContain(tokenOf(link.url));
    expect(stored!.token_ciphertext).not.toContain(tokenOf(link.url));

    await expectHttp(resolveReviewToken("not-a-token"), 404);
    await expectHttp(resolveReviewToken("A".repeat(43)), 404);

    // a video-scoped link cannot reach other videos, even in the same project
    const other = await uploadFile(projectId, sampleVideo());
    await expectHttp(assertVideoInScope(resolved, other.videoId), 404);
    // a project link cannot reach another project's video
    const otherProject = await createProject({ name: "Other client" }, EDITOR);
    const foreign = await uploadFile(otherProject, sampleVideo());
    const projectLink = await resolveReviewToken(tokenOf((await createReviewLink({ projectId, canComment: false }, EDITOR)).url));
    await assertVideoInScope(projectLink, other.videoId);
    await expectHttp(assertVideoInScope(projectLink, foreign.videoId), 404);
  });

  it("(5) comments store the entered name snapshot, integer ms timestamp and version", async () => {
    const link = await resolveReviewToken(tokenOf((await createReviewLink({ projectId, videoId, canComment: true }, EDITOR)).url));
    const guestKey = "browserkey_0123456789abcdef";
    const gid = await upsertGuestIdentity(link.id, guestKey, "Alex");
    const id = await createComment({
      videoId,
      versionId,
      authorType: "client",
      authorName: "Alex",
      guestIdentityId: gid,
      reviewLinkId: link.id,
      body: "Make this headline bigger and move it to the left.",
      timestampMs: 2400,
    });
    // guest renames later: earlier comments keep the old snapshot
    await upsertGuestIdentity(link.id, guestKey, "Alex Morgan");
    await createComment({ videoId, versionId, parentId: id, authorType: "client", authorName: "Alex Morgan", guestIdentityId: gid, body: "Also the logo." });
    await createComment({ videoId, versionId, parentId: id, authorType: "editor", authorName: EDITOR, body: "On it." });

    const [c] = (await listComments(versionId, { viewerGuestIdentityId: gid })).filter((x) => x.id === id);
    expect(c!.author_name).toBe("Alex");
    expect(c!.author_type).toBe("client");
    expect(c!.timestamp_ms).toBe(2400);
    expect(c!.video_version_id).toBe(versionId);
    expect(c!.is_mine).toBe(true);
    expect(c!.replies.map((r) => [r.author_name, r.author_type])).toEqual([
      ["Alex Morgan", "client"],
      [EDITOR, "editor"],
    ]);

    // timestamps must be integer milliseconds within the video
    await expectHttp(createComment({ videoId, versionId, authorType: "client", authorName: "Alex", body: "x", timestampMs: null }), 400);
    await expectHttp(createComment({ videoId, versionId, authorType: "client", authorName: "Alex", body: "x", timestampMs: 999_999 }), 400);

    await setCommentStatus(id, "resolved", { name: "Alex Morgan", type: "client" }, { videoId });
    const [resolved] = (await listComments(versionId)).filter((x) => x.id === id);
    expect(resolved!.status).toBe("resolved");
    expect(resolved!.resolved_by_name).toBe("Alex Morgan");
  });

  it("(15) revoked and expired links stop granting access", async () => {
    const link = await createReviewLink({ projectId, videoId, canComment: true }, EDITOR);
    const token = tokenOf(link.url);
    await resolveReviewToken(token);
    await updateReviewLink(link.id, { revoke: true }, EDITOR);
    const err = await expectHttp(resolveReviewToken(token), 410);
    expect(err.message).toMatch(/revoked/);

    const exp = await createReviewLink({ projectId, videoId, canComment: true, expiresAt: new Date(Date.now() + 60_000).toISOString() }, EDITOR);
    const db = await getDb();
    await db.query("update review_links set expires_at = now() - interval '1 second' where id = $1", [exp.id]);
    await expectHttp(resolveReviewToken(tokenOf(exp.url)), 410);

    // archived projects are not reviewable either
    const live = await createReviewLink({ projectId, videoId, canComment: true }, EDITOR);
    await db.query("update projects set status = 'archived' where id = $1", [projectId]);
    await expectHttp(resolveReviewToken(tokenOf(live.url)), 410);
    await db.query("update projects set status = 'active' where id = $1", [projectId]);
  });

  it("(16) interrupted uploads never become ready; they can be resumed or marked failed", async () => {
    const data = fs.readFileSync(sampleVideo());
    expect(data.length).toBeGreaterThan(0);
    // simulate a big file split into parts by sending only part of it
    const partial = await uploadFile(projectId, sampleVideo(), { videoId, skipComplete: true });
    const status = await uploadStatus(partial.versionId);
    expect(status.status).toBe("uploading");
    expect(status.uploadedParts.length).toBe(partial.parts.length);
    // completing with a missing part is refused and nothing is published
    if (partial.partCount === 1) {
      await expectHttp(completeUpload(partial.versionId, { parts: [] }, EDITOR), 400);
    }
    const view = await buildReviewView(videoId, { isEditor: false, canComment: true });
    expect(view.versions.find((v) => v.id === partial.versionId)).toBeUndefined(); // guests never see it
    await abortUpload(partial.versionId, "Test interruption", EDITOR);
    expect((await uploadStatus(partial.versionId)).status).toBe("failed");
    await expectHttp(completeUpload(partial.versionId, { parts: partial.parts }, EDITOR), 409);
  });
});
