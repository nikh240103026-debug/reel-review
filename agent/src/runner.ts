import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { z } from "zod";
import { ADAPTER_IDS, OP_TYPES, type AgentJobPayload } from "../../src/shared/operations";
import { AgentApiError, AgentClient } from "./client";
import { AGENT_VERSION, type AgentConfig } from "./config";
import { detectCapabilities } from "./adapters";
import { JobCancelledError, JobNoLongerRunningError, NonRetryableError, type EditorAdapter, type JobContext } from "./adapters/types";

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(t);
      resolve();
    });
  });

/** Defensive validation of the job payload before acting on it. */
const PayloadSchema = z.object({
  job: z.object({ id: z.string().uuid(), adapter: z.enum(ADAPTER_IDS), attempt: z.number().int().min(1), max_attempts: z.number(), lease_expires_at: z.string(), approved_hash: z.string().regex(/^[0-9a-f]{64}$/) }),
  project: z.object({ id: z.string(), name: z.string() }),
  video: z.object({ id: z.string(), title: z.string() }),
  source_version: z.object({
    id: z.string(),
    version_number: z.number(),
    download_url: z.string().url(),
    content_type: z.string(),
    size_bytes: z.number(),
    duration_ms: z.number().nullable(),
    width: z.number().nullable(),
    height: z.number().nullable(),
    frame_rate: z.number().nullable(),
    original_filename: z.string(),
  }),
  operations: z
    .array(
      z.object({
        id: z.string().uuid(),
        op_key: z.string(),
        op_type: z.enum(OP_TYPES),
        start_ms: z.number().int(),
        end_ms: z.number().int().nullable(),
        params: z.record(z.string(), z.unknown()),
        explanation: z.string(),
        execution_status: z.string().optional(),
        source_comments: z.array(z.object({ id: z.string(), author_name: z.string(), body: z.string(), timestamp_ms: z.number().nullable() })),
      }),
    )
    .min(1),
});

export interface RunnerOptions {
  once?: boolean;
  pollIntervalMs?: number;
  log?: (msg: string) => void;
}

export class AgentRunner {
  private client: AgentClient;
  private stopped = new AbortController();
  private adapters: Map<string, EditorAdapter>;
  private available: string[] = [];
  private capabilities: Record<string, unknown> = {};
  private say: (msg: string) => void;

  constructor(
    private cfg: AgentConfig,
    adapters: EditorAdapter[],
    private opts: RunnerOptions = {},
  ) {
    this.client = new AgentClient(cfg.server, cfg.token);
    this.adapters = new Map(adapters.map((a) => [a.id, a]));
    this.say = opts.log ?? ((m) => console.log(`[${new Date().toISOString()}] ${m}`));
  }

  stop() {
    this.stopped.abort();
  }

  private async refreshCapabilities() {
    const { caps, available } = await detectCapabilities([...this.adapters.values()]);
    this.available = available;
    this.capabilities = {
      platform: `${os.platform()} ${os.release()}`,
      hostname_hint: os.hostname().slice(0, 3) + "…",
      adapters: Object.fromEntries(caps.map((c) => [c.id, { implemented: c.implemented, automated: c.automated, supportedOps: c.supportedOps, details: c.details }])),
    };
  }

  async heartbeatDevice() {
    await this.client.heartbeatDevice({ agentVersion: AGENT_VERSION, adapters: this.available, capabilities: this.capabilities });
  }

  /** Main loop: heartbeat the device, claim approved jobs, execute them. */
  async run(): Promise<number> {
    await this.refreshCapabilities();
    this.say(`Agent ${AGENT_VERSION} for "${this.cfg.name}" → ${this.cfg.server}. Adapters: ${this.available.join(", ") || "none"}`);
    let lastBeat = 0;
    let processed = 0;
    while (!this.stopped.signal.aborted) {
      try {
        if (Date.now() - lastBeat > 30_000) {
          await this.heartbeatDevice();
          lastBeat = Date.now();
        }
        const { job } = await this.client.claim();
        if (job) {
          processed += 1;
          await this.runJob(job);
          lastBeat = 0;
          continue; // immediately look for more work
        }
        if (this.opts.once) return processed;
      } catch (err) {
        if (err instanceof AgentApiError && err.status === 401) {
          this.say("Server rejected this device token (revoked or unknown). Re-register the agent.");
          return processed;
        }
        this.say(`Server unreachable or error: ${(err as Error).message}. Retrying…`);
        if (this.opts.once) return processed;
      }
      await sleep(this.opts.pollIntervalMs ?? 5000, this.stopped.signal);
    }
    return processed;
  }

  async runJob(raw: AgentJobPayload): Promise<"completed" | "failed" | "cancelled" | "handed_off"> {
    const parsed = PayloadSchema.safeParse(raw);
    const jobId = raw?.job?.id;
    const attempt = raw?.job?.attempt;
    if (!parsed.success) {
      this.say(`Received a malformed job payload; refusing to execute.`);
      if (jobId && attempt) await this.client.job(jobId, { action: "fail", attempt, error: "Agent rejected malformed job payload", retryable: false }).catch(() => undefined);
      return "failed";
    }
    const payload = parsed.data as AgentJobPayload;
    const adapter = this.adapters.get(payload.job.adapter);
    const controller = new AbortController();
    const workDir = path.join(this.cfg.workDir, `${payload.job.id}-a${payload.job.attempt}`);
    fs.mkdirSync(workDir, { recursive: true });
    this.say(`Job ${payload.job.id} (${payload.job.adapter}, attempt ${payload.job.attempt}): ${payload.operations.length} approved operation(s) for "${payload.video.title}".`);

    let progress = 0;
    let message = "Starting";
    let jobGone = false;
    const beat = async () => {
      try {
        const res = await this.client.job<{ status: string; cancel_requested: boolean }>(
          payload.job.id,
          { action: "heartbeat", attempt: payload.job.attempt, progress, message },
          1,
        );
        if (res.cancel_requested) controller.abort(new JobCancelledError("Cancelled by editor"));
        if (res.status !== "running") {
          jobGone = true;
          controller.abort(new JobNoLongerRunningError(`Job is ${res.status}`));
        }
      } catch (err) {
        if (err instanceof AgentApiError && err.status === 409) {
          // lease lost (reassigned): stop immediately, never complete a stale attempt
          jobGone = true;
          controller.abort(new JobNoLongerRunningError("Lease lost"));
        }
      }
    };
    const timer = setInterval(beat, 25_000);

    const ctx: JobContext = {
      payload,
      workDir,
      signal: controller.signal,
      log: async (level, msg, data) => {
        this.say(`  ${level.toUpperCase()} ${msg}`);
        await this.client.job(payload.job.id, { action: "log", entries: [{ level, message: msg, data }] }, 2).catch(() => undefined);
      },
      progress: (f, m) => {
        progress = Math.max(0, Math.min(1, f));
        message = m;
      },
      reportOperation: async (opId, status, note) => {
        await this.client.job(payload.job.id, { action: "operations", attempt: payload.job.attempt, updates: [{ op_id: opId, status, note: note ?? null }] }, 2);
      },
      fetchState: () => this.client.jobState(payload.job.id),
    };

    try {
      if (!adapter) throw new NonRetryableError(`Adapter ${payload.job.adapter} is not available on this device`);
      const caps = await adapter.getCapabilities();
      if (!caps.implemented) throw new NonRetryableError(`${caps.label} is not implemented on this agent`);
      await beat();

      if (adapter.needsSource) {
        ctx.progress(0.02, "Downloading source");
        await ctx.log("info", `Downloading source v${payload.source_version.version_number} (${(payload.source_version.size_bytes / 1024 / 1024).toFixed(1)} MB)`);
        const ext = path.extname(payload.source_version.original_filename || ".mp4").toLowerCase() || ".mp4";
        await download(payload.source_version.download_url, path.join(workDir, `source${ext}`), payload.source_version.size_bytes, controller.signal, (f) =>
          ctx.progress(0.02 + f * 0.13, "Downloading source"),
        );
      }

      ctx.progress(0.15, "Inspecting project");
      const inspection = await adapter.inspectProject(ctx);
      await ctx.log("info", `Inspection: ${inspection.notes.join(", ")}`);

      // Validate every operation before touching anything.
      const problems: string[] = [];
      for (const op of payload.operations) {
        if (!caps.supportedOps.includes(op.op_type)) problems.push(`${op.op_key}: ${op.op_type} not supported by ${caps.label} on this device`);
        const v = adapter.validateOperation(op, inspection);
        if (!v.ok) problems.push(...v.errors.map((e) => `${op.op_key}: ${e}`));
      }
      if (problems.length) throw new NonRetryableError(`Validation failed on the agent: ${problems.join("; ")}`);

      for (const op of payload.operations) {
        if (controller.signal.aborted) throw controller.signal.reason;
        await ctx.reportOperation(op.id, "running");
        const outcome = await adapter.executeApprovedOperation(op, ctx, inspection);
        await ctx.reportOperation(op.id, outcome.status, outcome.note);
      }

      const result = await adapter.finalizeJob(ctx, inspection);
      if (controller.signal.aborted) throw controller.signal.reason;
      if (!result.render) throw new NonRetryableError("Adapter produced no render");

      ctx.progress(0.82, "Uploading render");
      const size = fs.statSync(result.render.path).size;
      await ctx.log("info", `Uploading render (${(size / 1024 / 1024).toFixed(1)} MB)`);
      const parts = await this.uploadRender(payload, result.render.path, size, result.render.contentType, result.render.filename, controller.signal, (f) =>
        ctx.progress(0.82 + f * 0.15, "Uploading render"),
      );
      ctx.progress(0.98, "Finalizing");
      const done = await this.client.job<{ status: string; version_id: string | null }>(payload.job.id, {
        action: "complete",
        attempt: payload.job.attempt,
        summary: result.summary,
        render: { parts, sizeBytes: size, filename: result.render.filename, contentType: result.render.contentType },
      });
      if (done.status !== "completed") throw new Error(`Server did not accept the render (status ${done.status})`);
      this.say(`Job ${payload.job.id} completed. New version ${done.version_id}.`);
      fs.rmSync(workDir, { recursive: true, force: true });
      return "completed";
    } catch (err) {
      const reason = controller.signal.aborted ? controller.signal.reason : err;
      if (reason instanceof JobNoLongerRunningError || jobGone) {
        this.say(`Job ${payload.job.id} is no longer assigned to this agent (${(reason as Error).message}). Stopping.`);
        await adapter?.cancelJob(payload.job.id);
        return "handed_off";
      }
      if (reason instanceof JobCancelledError) {
        await adapter?.cancelJob(payload.job.id);
        await this.client.job(payload.job.id, { action: "fail", attempt: payload.job.attempt, error: "Stopped by cancellation request", retryable: false, cancelled: true }).catch(() => undefined);
        this.say(`Job ${payload.job.id} cancelled.`);
        return "cancelled";
      }
      const retryable = !(err instanceof NonRetryableError) && !(err instanceof AgentApiError && !err.retryable);
      const msg = (err as Error).message ?? String(err);
      this.say(`Job ${payload.job.id} failed: ${msg}`);
      await adapter?.cancelJob(payload.job.id);
      await this.client.job(payload.job.id, { action: "fail", attempt: payload.job.attempt, error: msg.slice(0, 1900), retryable }).catch((e) =>
        this.say(`Could not report failure (${(e as Error).message}); the server lease will expire and the job will be retried or failed.`),
      );
      return "failed";
    } finally {
      clearInterval(timer);
    }
  }

  private async uploadRender(
    payload: AgentJobPayload,
    file: string,
    size: number,
    contentType: string,
    filename: string,
    signal: AbortSignal,
    onProgress: (f: number) => void,
  ) {
    const init = await this.client.job<{ partSize: number; partCount: number }>(payload.job.id, {
      action: "start_render_upload",
      attempt: payload.job.attempt,
      sizeBytes: size,
      contentType,
      filename,
    });
    const parts: { partNumber: number; etag: string }[] = [];
    const fd = fs.openSync(file, "r");
    try {
      for (let start = 1; start <= init.partCount; start += 20) {
        const numbers = Array.from({ length: Math.min(20, init.partCount - start + 1) }, (_, i) => start + i);
        const { urls } = await this.client.job<{ urls: Record<string, string> }>(payload.job.id, {
          action: "render_parts",
          attempt: payload.job.attempt,
          partNumbers: numbers,
        });
        for (const n of numbers) {
          if (signal.aborted) throw signal.reason;
          const offset = (n - 1) * init.partSize;
          const len = Math.min(init.partSize, size - offset);
          const buf = Buffer.alloc(len);
          fs.readSync(fd, buf, 0, len, offset);
          let etag: string | null = null;
          for (let attempt = 0; attempt < 4 && !etag; attempt++) {
            try {
              const res = await fetch(urls[n]!, { method: "PUT", body: buf, signal });
              if (!res.ok) throw new Error(`storage responded ${res.status}`);
              etag = res.headers.get("etag");
              if (!etag) throw new NonRetryableError("Storage did not return an ETag (check bucket CORS/expose headers)");
            } catch (err) {
              if (err instanceof NonRetryableError || signal.aborted || attempt === 3) throw err;
              await sleep(1000 * 2 ** attempt);
            }
          }
          parts.push({ partNumber: n, etag: etag! });
          onProgress(parts.length / init.partCount);
        }
      }
    } finally {
      fs.closeSync(fd);
    }
    return parts;
  }
}

async function download(url: string, dest: string, expectedSize: number, signal: AbortSignal, onProgress: (f: number) => void) {
  let lastErr: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(url, { signal });
      if (!res.ok || !res.body) throw new Error(`Source download failed (HTTP ${res.status})`);
      let received = 0;
      const counter = new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, c) {
          received += chunk.byteLength;
          if (expectedSize) onProgress(received / expectedSize);
          c.enqueue(chunk);
        },
      });
      await pipeline(Readable.fromWeb(res.body.pipeThrough(counter) as import("node:stream/web").ReadableStream), fs.createWriteStream(dest));
      const size = fs.statSync(dest).size;
      if (expectedSize && size !== expectedSize) throw new Error(`Downloaded ${size} bytes, expected ${expectedSize}`);
      return;
    } catch (err) {
      if (signal.aborted) throw signal.reason;
      lastErr = err;
      await sleep(1000 * 2 ** attempt);
    }
  }
  throw lastErr;
}
