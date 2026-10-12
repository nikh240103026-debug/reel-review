import { z } from "zod";
import { handler, json, parseBody, assertUuid, type Ctx } from "@/lib/http";
import { requireEditor } from "@/lib/auth/editor";
import { completeUpload } from "@/lib/services/videos";
import { attachManualRevision } from "@/lib/services/jobs";

const Body = z.object({
  parts: z.array(z.object({ partNumber: z.number().int().positive(), etag: z.string().min(1).max(200) })).min(1).max(10_000),
  metadata: z
    .object({
      durationMs: z.number().nonnegative().nullable().optional(),
      width: z.number().int().positive().nullable().optional(),
      height: z.number().int().positive().nullable().optional(),
      browserPlayable: z.boolean().nullable().optional(),
    })
    .optional(),
  thumbnailUploaded: z.boolean().optional(),
});

export const POST = handler(async (req, { params }: Ctx<{ versionId: string }>) => {
  const editor = await requireEditor(req);
  const versionId = assertUuid((await params).versionId, "version");
  const version = await completeUpload(versionId, await parseBody(req, Body), editor.name);
  if (version.produced_by_job_id && version.status === "ready") {
    await attachManualRevision(version.produced_by_job_id, version.id, editor.name);
  }
  return json({ version });
});
