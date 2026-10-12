import { z } from "zod";
import { handler, json, parseBody, assertUuid, type Ctx } from "@/lib/http";
import { requireEditor } from "@/lib/auth/editor";
import { abortUpload } from "@/lib/services/videos";

const Body = z.object({ reason: z.string().max(500).default("Upload cancelled") });

export const POST = handler(async (req, { params }: Ctx<{ versionId: string }>) => {
  const editor = await requireEditor(req);
  const { reason } = await parseBody(req, Body);
  await abortUpload(assertUuid((await params).versionId, "version"), reason, editor.name);
  return json({ ok: true });
});
