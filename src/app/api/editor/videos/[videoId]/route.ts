import { z } from "zod";
import { handler, json, parseBody, assertUuid, type Ctx } from "@/lib/http";
import { requireEditor } from "@/lib/auth/editor";
import { buildReviewView } from "@/lib/services/review-view";
import { updateVideo } from "@/lib/services/videos";

export const GET = handler(async (req, { params }: Ctx<{ videoId: string }>) => {
  await requireEditor(req);
  return json(await buildReviewView(assertUuid((await params).videoId, "video"), { isEditor: true, canComment: true }));
});

const Patch = z.object({
  title: z.string().trim().min(1).max(300).optional(),
  status: z.enum(["active", "archived"]).optional(),
});

export const PATCH = handler(async (req, { params }: Ctx<{ videoId: string }>) => {
  const editor = await requireEditor(req);
  await updateVideo(assertUuid((await params).videoId, "video"), await parseBody(req, Patch), editor.name);
  return json({ ok: true });
});
