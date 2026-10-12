import { z } from "zod";
import { handler, json, parseBody, parseQuery, assertUuid, type Ctx } from "@/lib/http";
import { requireEditor } from "@/lib/auth/editor";
import { createComment, listComments } from "@/lib/services/comments";
import { NewCommentRequest } from "@/lib/services/review-view";

export const GET = handler(async (req, { params }: Ctx<{ videoId: string }>) => {
  await requireEditor(req);
  assertUuid((await params).videoId, "video");
  const { versionId } = parseQuery(req, z.object({ versionId: z.string().uuid() }));
  return json({ comments: await listComments(versionId) });
});

/** Editor notes are labelled author_type "editor". */
export const POST = handler(async (req, { params }: Ctx<{ videoId: string }>) => {
  const editor = await requireEditor(req);
  const videoId = assertUuid((await params).videoId, "video");
  const b = await parseBody(req, NewCommentRequest);
  const id = await createComment({
    videoId,
    versionId: b.versionId,
    parentId: b.parentId ?? null,
    authorType: "editor",
    authorName: editor.name,
    body: b.body,
    timestampMs: b.timestampMs ?? null,
    annotation: b.annotation ?? null,
  });
  return json({ id }, 201);
});
