import { describe, it, expect, beforeAll } from "vitest";
import { freshDb, setupProjectWithVideo, getDb } from "./helpers";
import { createReviewLink, resolveReviewToken } from "@/lib/services/review-links";
import { createComment, listComments, upsertGuestIdentity } from "@/lib/services/comments";

describe("smoke: schema + upload + comment", () => {
  beforeAll(async () => {
    await freshDb();
  });

  it("migrates, uploads a real video, and stores a guest comment", async () => {
    const db = await getDb();
    const [ws] = await db.query<{ count: number }>("select count(*)::int as count from workspaces");
    expect(ws!.count).toBe(1);

    const { projectId, videoId, versionId, upload } = await setupProjectWithVideo();
    expect(upload.version!.status).toBe("ready");
    expect(upload.version!.duration_ms).toBeGreaterThan(5000);
    expect(upload.version!.frame_rate).toBe(30);

    const link = await createReviewLink({ projectId, videoId, canComment: true }, "Ed");
    const token = link.url!.split("/r/")[1]!;
    const resolved = await resolveReviewToken(token);
    expect(resolved.video_id).toBe(videoId);

    const guestId = await upsertGuestIdentity(resolved.id, "guestkey_abcdefghijklmnop", "Alex");
    await createComment({
      videoId,
      versionId,
      authorType: "client",
      authorName: "Alex",
      guestIdentityId: guestId,
      reviewLinkId: resolved.id,
      body: "Make this headline bigger and move it to the left.",
      timestampMs: 12400,
    }).catch(async (e) => {
      // sample is 6s long; 12.4s is beyond the end and must be rejected
      expect(String(e.message)).toMatch(/beyond the end/);
    });
    await createComment({
      videoId,
      versionId,
      authorType: "client",
      authorName: "Alex",
      guestIdentityId: guestId,
      reviewLinkId: resolved.id,
      body: "Make this headline bigger and move it to the left.",
      timestampMs: 2400,
    });
    const comments = await listComments(versionId, { viewerGuestIdentityId: guestId });
    expect(comments).toHaveLength(1);
    expect(comments[0]!.author_name).toBe("Alex");
    expect(comments[0]!.timestamp_ms).toBe(2400);
    expect(comments[0]!.is_mine).toBe(true);
  });
});
