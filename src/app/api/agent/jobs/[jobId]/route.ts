import { z } from "zod";
import { handler, json, parseBody, assertUuid, badRequest, type Ctx } from "@/lib/http";
import { requireAgent } from "@/lib/auth/agent";
import {
  appendAgentLogs,
  completeJob,
  failJob,
  getAgentJobState,
  heartbeat,
  presignRenderParts,
  reportOperationStatus,
  startRenderUpload,
} from "@/lib/services/jobs";

export const GET = handler(async (req, { params }: Ctx<{ jobId: string }>) => {
  const device = await requireAgent(req);
  return json(await getAgentJobState(device, assertUuid((await params).jobId, "job")));
});

const attempt = z.number().int().min(1);
const Action = z.discriminatedUnion("action", [
  z.object({ action: z.literal("heartbeat"), attempt, progress: z.number().min(0).max(1).optional(), message: z.string().max(300).optional() }),
  z.object({
    action: z.literal("log"),
    entries: z
      .array(z.object({ level: z.enum(["debug", "info", "warn", "error"]), message: z.string().max(4000), data: z.unknown().optional() }))
      .min(1)
      .max(50),
  }),
  z.object({
    action: z.literal("operations"),
    attempt,
    updates: z.array(z.object({ op_id: z.string().uuid(), status: z.string().max(30), note: z.string().max(1000).nullable().optional() })).max(200),
  }),
  z.object({
    action: z.literal("start_render_upload"),
    attempt,
    sizeBytes: z.number().int().positive(),
    contentType: z.string().max(100),
    filename: z.string().max(300),
  }),
  z.object({ action: z.literal("render_parts"), attempt, partNumbers: z.array(z.number().int().positive()).min(1).max(100) }),
  z.object({
    action: z.literal("complete"),
    attempt,
    summary: z.string().max(2000).optional(),
    render: z
      .object({
        parts: z.array(z.object({ partNumber: z.number().int().positive(), etag: z.string().min(1).max(200) })).min(1),
        sizeBytes: z.number().int().positive(),
        filename: z.string().max(300),
        contentType: z.string().max(100),
      })
      .nullable()
      .optional(),
  }),
  z.object({
    action: z.literal("fail"),
    attempt,
    error: z.string().min(1).max(2000),
    retryable: z.boolean(),
    cancelled: z.boolean().optional(),
  }),
]);

/**
 * Job protocol for the local agent. Every call is bound to the device that
 * holds the lease and to the current attempt number, so a stale or duplicate
 * agent cannot complete or modify a reassigned job.
 */
export const POST = handler(async (req, { params }: Ctx<{ jobId: string }>) => {
  const device = await requireAgent(req);
  const jobId = assertUuid((await params).jobId, "job");
  const b = await parseBody(req, Action);
  switch (b.action) {
    case "heartbeat":
      return json(await heartbeat(device, jobId, b));
    case "log":
      await appendAgentLogs(device, jobId, b.entries);
      return json({ ok: true });
    case "operations":
      await reportOperationStatus(device, jobId, b.attempt, b.updates);
      return json({ ok: true });
    case "start_render_upload":
      return json(await startRenderUpload(device, jobId, b));
    case "render_parts":
      return json({ urls: await presignRenderParts(device, jobId, b.attempt, b.partNumbers) });
    case "complete":
      return json(await completeJob(device, jobId, b));
    case "fail":
      return json(await failJob(device, jobId, b));
    default:
      throw badRequest("Unknown action");
  }
});
