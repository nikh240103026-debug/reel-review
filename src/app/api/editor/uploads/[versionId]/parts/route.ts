import { z } from "zod";
import { handler, json, parseBody, assertUuid, type Ctx } from "@/lib/http";
import { requireEditor } from "@/lib/auth/editor";
import { presignParts } from "@/lib/services/videos";

const Body = z.object({ partNumbers: z.array(z.number().int().positive()).min(1).max(100) });

export const POST = handler(async (req, { params }: Ctx<{ versionId: string }>) => {
  await requireEditor(req);
  const { partNumbers } = await parseBody(req, Body);
  return json({ urls: await presignParts(assertUuid((await params).versionId, "version"), partNumbers) });
});
