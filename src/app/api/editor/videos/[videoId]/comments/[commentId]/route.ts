import { handler, json, parseBody, assertUuid, type Ctx } from "@/lib/http";
import { requireEditor } from "@/lib/auth/editor";
import { setCommentStatus } from "@/lib/services/comments";
import { CommentStatusRequest } from "@/lib/services/review-view";

export const PATCH = handler(async (req, { params }: Ctx<{ videoId: string; commentId: string }>) => {
  const editor = await requireEditor(req);
  const p = await params;
  const { status } = await parseBody(req, CommentStatusRequest);
  await setCommentStatus(
    assertUuid(p.commentId, "comment"),
    status,
    { name: editor.name, type: "editor" },
    { videoId: assertUuid(p.videoId, "video") },
  );
  return json({ ok: true });
});
