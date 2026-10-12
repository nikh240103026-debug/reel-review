import { handler, json, assertUuid, type Ctx } from "@/lib/http";
import { requireEditor } from "@/lib/auth/editor";
import { presignThumbnail } from "@/lib/services/videos";

export const POST = handler(async (req, { params }: Ctx<{ versionId: string }>) => {
  await requireEditor(req);
  const { url } = await presignThumbnail(assertUuid((await params).versionId, "version"));
  return json({ url, contentType: "image/jpeg" });
});
