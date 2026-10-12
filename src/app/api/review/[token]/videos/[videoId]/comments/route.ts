import { z } from "zod";
import { handler, json, parseBody, parseQuery, assertUuid, badRequest, type Ctx } from "@/lib/http";
import { assertGuestVersion, guestVideoAccess } from "@/lib/services/guest-access";
import { DisplayName, GuestKey, createComment, listComments, upsertGuestIdentity } from "@/lib/services/comments";
import { NewCommentRequest } from "@/lib/services/review-view";

export const GET = handler(async (req, { params }: Ctx<{ token: string; videoId: string }>) => {
  const p = await params;
  const videoId = assertUuid(p.videoId, "video");
  const { guestIdentityId } = await guestVideoAccess(req, p.token, videoId);
  const { versionId } = parseQuery(req, z.object({ versionId: z.string().uuid() }));
  await assertGuestVersion(videoId, versionId);
  return json({ comments: await listComments(versionId, { viewerGuestIdentityId: guestIdentityId }) });
});

const GuestComment = NewCommentRequest.extend({ authorName: DisplayName });

/** Guest comments: the review link grants permission; the name is a snapshot label. */
export const POST = handler(async (req, { params }: Ctx<{ token: string; videoId: string }>) => {
  const p = await params;
  const videoId = assertUuid(p.videoId, "video");
  const { link } = await guestVideoAccess(req, p.token, videoId, { write: true });
  const guestKey = GuestKey.safeParse(req.headers.get("x-guest-key"));
  if (!guestKey.success) throw badRequest("Missing guest key; reload the page");
  const b = await parseBody(req, GuestComment);
  await assertGuestVersion(videoId, b.versionId);
  const guestIdentityId = await upsertGuestIdentity(link.id, guestKey.data, b.authorName);
  const id = await createComment({
    videoId,
    versionId: b.versionId,
    parentId: b.parentId ?? null,
    authorType: "client",
    authorName: b.authorName,
    guestIdentityId,
    reviewLinkId: link.id,
    body: b.body,
    timestampMs: b.timestampMs ?? null,
    annotation: b.annotation ?? null,
  });
  return json({ id }, 201);
});
