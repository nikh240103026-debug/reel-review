import fs from "node:fs";
import path from "node:path";
import { OP_LABELS, OP_TYPES, validateOperationShape, type AgentJobOperation } from "../../../src/shared/operations";
import { JobCancelledError, JobNoLongerRunningError, type AdapterCapabilities, type EditorAdapter, type ExecutionResult, type JobContext, type OperationOutcome, type ProjectInspection } from "./types";

const VIDEO_EXT = new Set([".mp4", ".mov", ".m4v", ".webm", ".mkv"]);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function tc(ms: number | null) {
  if (ms === null) return "";
  const s = ms / 1000;
  const m = Math.floor(s / 60);
  return `${String(m).padStart(2, "0")}:${(s - m * 60).toFixed(3).padStart(6, "0")}`;
}

/**
 * Manual adapter: turns approved operations into a checklist for a human
 * editor. Nothing is changed automatically. Tasks are ticked off in the web
 * app; when all are done and a render file is placed in the job's `render`
 * folder, the agent uploads it as the new version.
 */
export class ManualAdapter implements EditorAdapter {
  readonly id = "manual" as const;
  readonly needsSource = false;
  private waiting = new Set<string>();

  async getCapabilities(): Promise<AdapterCapabilities> {
    return {
      id: "manual",
      label: "Manual checklist",
      implemented: true,
      automated: false,
      supportedOps: [...OP_TYPES],
      details: { renderFolder: "render/ inside each job folder" },
    };
  }

  async inspectProject(ctx: JobContext): Promise<ProjectInspection> {
    const p = ctx.payload;
    fs.mkdirSync(path.join(ctx.workDir, "render"), { recursive: true });
    const lines = [
      `# Edit checklist — ${p.project.name} / ${p.video.title}`,
      ``,
      `Source: version ${p.source_version.version_number} (${p.source_version.original_filename})`,
      `Job: ${p.job.id} (attempt ${p.job.attempt})`,
      `Approved revision hash: ${p.job.approved_hash}`,
      ``,
      `Tick each task in the ReelReview web app (Jobs → this job) when done.`,
      `Then export the revised video into:`,
      `  ${path.join(ctx.workDir, "render")}`,
      `The agent uploads it automatically as a new version. Or upload it from the web app.`,
      ``,
      `## Tasks`,
      ``,
      ...p.operations.flatMap((op, i) => [
        `### ${i + 1}. ${OP_LABELS[op.op_type] ?? op.op_type} @ ${tc(op.start_ms)}${op.end_ms !== null ? ` → ${tc(op.end_ms)}` : ""}`,
        ``,
        op.explanation,
        ``,
        "Parameters: `" + JSON.stringify(op.params) + "`",
        ...op.source_comments.map((c) => `> ${c.author_name} at ${tc(c.timestamp_ms)}: ${c.body.replace(/\n/g, " ")}`),
        ``,
      ]),
    ];
    fs.writeFileSync(path.join(ctx.workDir, "CHECKLIST.md"), lines.join("\n"), "utf8");
    fs.writeFileSync(path.join(ctx.workDir, "job.json"), JSON.stringify({ ...p, source_version: { ...p.source_version, download_url: "[omitted]" } }, null, 2));
    await ctx.log("info", `Checklist written to ${path.join(ctx.workDir, "CHECKLIST.md")}`);
    return {
      sourcePath: null,
      durationMs: p.source_version.duration_ms,
      width: p.source_version.width,
      height: p.source_version.height,
      frameRate: p.source_version.frame_rate,
      hasAudio: null,
      notes: ["manual checklist"],
    };
  }

  validateOperation(op: AgentJobOperation, insp: ProjectInspection) {
    return validateOperationShape(op, insp.durationMs);
  }

  async executeApprovedOperation(op: AgentJobOperation): Promise<OperationOutcome> {
    if (op.execution_status === "manual_done") return { status: "skipped", note: "Already marked done" };
    return { status: "manual_pending", note: "Waiting for a human editor" };
  }

  async finalizeJob(ctx: JobContext): Promise<ExecutionResult> {
    const jobId = ctx.payload.job.id;
    this.waiting.add(jobId);
    const renderDir = path.join(ctx.workDir, "render");
    ctx.progress(0.1, "Waiting for the editor to complete the checklist");
    let lastSize = -1;
    let lastNotice = 0;
    try {
      for (;;) {
        if (ctx.signal.aborted) throw new JobCancelledError("Cancelled");
        const state = await ctx.fetchState();
        if (state.status !== "running") throw new JobNoLongerRunningError(`Job is now ${state.status}`);
        const total = ctx.payload.operations.length;
        const done = state.operations.filter((o) => o.execution_status === "manual_done").length;
        ctx.progress(0.1 + (done / Math.max(1, total)) * 0.6, `${done}/${total} tasks done`);
        if (done === total) {
          const file = fs
            .readdirSync(renderDir)
            .filter((f) => VIDEO_EXT.has(path.extname(f).toLowerCase()))
            .map((f) => path.join(renderDir, f))
            .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0];
          if (file) {
            const size = fs.statSync(file).size;
            if (size > 0 && size === lastSize) {
              await ctx.log("info", `Render found: ${path.basename(file)} (${(size / 1024 / 1024).toFixed(1)} MB)`);
              const ext = path.extname(file).toLowerCase();
              const type = ext === ".mov" ? "video/quicktime" : ext === ".webm" ? "video/webm" : ext === ".mkv" ? "video/x-matroska" : "video/mp4";
              return { render: { path: file, contentType: type, filename: path.basename(file) }, summary: "Manual edit; render exported by the editor." };
            }
            lastSize = size; // wait until the file stops growing
          } else if (Date.now() - lastNotice > 120_000) {
            lastNotice = Date.now();
            await ctx.log("info", `All tasks done. Waiting for a render in ${renderDir} (or upload it / finish in the web app).`);
          }
        }
        await sleep(5000);
      }
    } finally {
      this.waiting.delete(jobId);
    }
  }

  getJobStatus(jobId: string) {
    return this.waiting.has(jobId) ? { state: "waiting_for_human" as const } : { state: "idle" as const };
  }

  async cancelJob(jobId: string) {
    this.waiting.delete(jobId);
  }
}
