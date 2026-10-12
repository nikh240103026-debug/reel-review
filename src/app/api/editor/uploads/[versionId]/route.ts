import { handler, json, assertUuid, type Ctx } from "@/lib/http";
import { requireEditor } from "@/lib/auth/editor";
import { uploadStatus } from "@/lib/services/videos";

/** Lists parts already stored so an interrupted upload can resume. */
export const GET = handler(async (req, { params }: Ctx<{ versionId: string }>) => {
  await requireEditor(req);
  return json(await uploadStatus(assertUuid((await params).versionId, "version")));
});
