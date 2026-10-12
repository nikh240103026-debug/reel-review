import { z } from "zod";
import { handler, json, parseBody } from "@/lib/http";
import { requireEditor } from "@/lib/auth/editor";
import { startUpload } from "@/lib/services/videos";

const Start = z.object({
  projectId: z.string().uuid(),
  videoId: z.string().uuid().optional(),
  title: z.string().trim().max(300).optional(),
  filename: z.string().trim().min(1).max(500),
  contentType: z.string().max(100),
  sizeBytes: z.number().int().positive(),
  source: z.enum(["upload", "manual_revision"]).optional(),
  jobId: z.string().uuid().optional(),
  proposalId: z.string().uuid().optional(),
  notes: z.string().trim().max(2000).optional(),
});

/** Starts a direct-to-storage multipart upload. No video bytes pass through this route. */
export const POST = handler(async (req) => {
  const editor = await requireEditor(req);
  const b = await parseBody(req, Start);
  const res = await startUpload(
    {
      projectId: b.projectId,
      videoId: b.videoId,
      title: b.title,
      filename: b.filename,
      contentType: b.contentType,
      sizeBytes: b.sizeBytes,
      source: b.source,
      producedByJobId: b.jobId ?? null,
      producedByProposalId: b.proposalId ?? null,
      notes: b.notes ?? null,
    },
    editor.name,
  );
  return json(res, 201);
});
