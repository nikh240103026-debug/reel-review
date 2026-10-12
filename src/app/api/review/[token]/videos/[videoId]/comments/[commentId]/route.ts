import { handler, json, parseBody, assertUuid, badRequest, type Ctx } from "@/lib/http";
import { guestVideoAccess } from "@/lib/services/guest-access";
import { DisplayName, setCommentStatus } from "@/lib/services/comments";
import { CommentStatusRequest } from "@/lib/services/review-view";

const Body = CommentStatusRequest.extend({ actorName: DisplayName.optional() });

export const PATCH = handler(async (req, { params }: Ctx<{ token: string; videoId: string; commentId: string }>) => {
  const p = await params;
  const videoId = assertUuid(p.videoId, "video");
  await guestVideoAccess(req, p.token, videoId, { write: true });
  const { status, actorName } = await parseBody(req, Body);
  if (!actorName) throw badRequest("Enter your name first");
  await setCommentStatus(assertUuid(p.commentId, "comment"), status, { name: actorName, type: "client" }, { videoId });
  return json({ ok: true });
});
