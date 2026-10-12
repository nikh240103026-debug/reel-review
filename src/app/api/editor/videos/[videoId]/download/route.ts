import { z } from "zod";
import { handler, json, parseQuery, assertUuid, notFound, type Ctx } from "@/lib/http";
import { requireEditor } from "@/lib/auth/editor";
import { getDb } from "@/lib/db";
import { getVersionDownloadUrl } from "@/lib/services/videos";

export const GET = handler(async (req, { params }: Ctx<{ videoId: string }>) => {
  await requireEditor(req);
  const videoId = assertUuid((await params).videoId, "video");
  const { versionId } = parseQuery(req, z.object({ versionId: z.string().uuid() }));
  const db = await getDb();
  const [v] = await db.query<{ video_id: string }>("select video_id from video_versions where id = $1", [versionId]);
  if (!v || v.video_id !== videoId) throw notFound("Version not found");
  return json({ url: await getVersionDownloadUrl(versionId) });
});
