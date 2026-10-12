import fs from "node:fs";
import path from "node:path";
import type { ChildProcess } from "node:child_process";
import { PARAM_SCHEMAS, validateOperationShape, type AgentJobOperation, type OpType } from "../../../src/shared/operations";
import { findFont, probe, runFfmpeg, toolVersion, ffmpegBin, ffprobeBin } from "../media";
import { NonRetryableError, type AdapterCapabilities, type EditorAdapter, type ExecutionResult, type JobContext, type OperationOutcome, type ProjectInspection } from "./types";

/**
 * FFmpeg adapter: applies supported operations to the flattened source video
 * and renders a new file. It cannot modify layers inside editor projects;
 * operations that would need that are not advertised.
 */

interface Plan {
  overlays: { text: string; startMs: number; endMs: number; position: string; fontPx: number; color: string }[];
  gains: { startMs: number; endMs: number; gainDb: number }[];
  removes: [number, number][];
  keeps: [number, number][];
}

const POS: Record<string, { x: string; y: string }> = {
  top_left: { x: "w*0.05", y: "h*0.06" },
  top: { x: "(w-text_w)/2", y: "h*0.06" },
  top_right: { x: "w-text_w-w*0.05", y: "h*0.06" },
  left: { x: "w*0.05", y: "(h-text_h)/2" },
  center: { x: "(w-text_w)/2", y: "(h-text_h)/2" },
  right: { x: "w-text_w-w*0.05", y: "(h-text_h)/2" },
  bottom_left: { x: "w*0.05", y: "h-text_h-h*0.08" },
  bottom: { x: "(w-text_w)/2", y: "h-text_h-h*0.08" },
  bottom_right: { x: "w-text_w-w*0.05", y: "h-text_h-h*0.08" },
};

const sec = (ms: number) => (ms / 1000).toFixed(3);

/** Segments of the source timeline to keep after keep/remove trims. */
export function computeSegments(durationMs: number, keeps: [number, number][], removes: [number, number][]): [number, number][] {
  let segs: [number, number][] = keeps.length ? [...keeps].sort((a, b) => a[0] - b[0]) : [[0, durationMs]];
  // merge overlapping keeps
  segs = segs.reduce<[number, number][]>((acc, s) => {
    const last = acc[acc.length - 1];
    if (last && s[0] <= last[1]) last[1] = Math.max(last[1], s[1]);
    else acc.push([Math.max(0, s[0]), Math.min(durationMs, s[1])]);
    return acc;
  }, []);
  for (const [rs, re] of removes) {
    segs = segs.flatMap(([s, e]): [number, number][] => {
      if (re <= s || rs >= e) return [[s, e]];
      const out: [number, number][] = [];
      if (rs > s) out.push([s, rs]);
      if (re < e) out.push([re, e]);
      return out;
    });
  }
  return segs.filter(([s, e]) => e - s >= 40); // drop slivers shorter than ~1 frame
}

export function buildFilterGraph(plan: Plan, insp: { durationMs: number; hasAudio: boolean }, overlayFiles: string[], fontFile: string) {
  const v: string[] = [];
  let vLabel = "0:v";
  plan.overlays.forEach((o, i) => {
    const p = POS[o.position] ?? POS.bottom!;
    const out = `vo${i}`;
    v.push(
      `[${vLabel}]drawtext=fontfile=${fontFile}:textfile=${overlayFiles[i]}:expansion=none:fontsize=${o.fontPx}:fontcolor=0x${o.color.replace("#", "")}` +
        `:x=${p.x}:y=${p.y}:box=1:boxcolor=black@0.35:boxborderw=${Math.round(o.fontPx * 0.3)}` +
        `:enable='between(t,${sec(o.startMs)},${sec(o.endMs)})'[${out}]`,
    );
    vLabel = out;
  });
  let aLabel = insp.hasAudio ? "0:a" : null;
  plan.gains.forEach((g, i) => {
    const out = `ag${i}`;
    v.push(`[${aLabel}]volume=volume=${g.gainDb}dB:enable='between(t,${sec(g.startMs)},${sec(g.endMs)})'[${out}]`);
    aLabel = out;
  });

  const segments = computeSegments(insp.durationMs, plan.keeps, plan.removes);
  const trimming = plan.keeps.length > 0 || plan.removes.length > 0;
  if (!segments.length) throw new NonRetryableError("Trims would remove the entire video");
  let outV = vLabel;
  let outA = aLabel;
  if (trimming) {
    const n = segments.length;
    v.push(`[${vLabel}]split=${n}${segments.map((_, i) => `[vs${i}]`).join("")}`);
    if (aLabel) v.push(`[${aLabel}]asplit=${n}${segments.map((_, i) => `[as${i}]`).join("")}`);
    segments.forEach(([s, e], i) => {
      v.push(`[vs${i}]trim=start=${sec(s)}:end=${sec(e)},setpts=PTS-STARTPTS[vt${i}]`);
      if (aLabel) v.push(`[as${i}]atrim=start=${sec(s)}:end=${sec(e)},asetpts=PTS-STARTPTS[at${i}]`);
    });
    const inputs = segments.map((_, i) => (aLabel ? `[vt${i}][at${i}]` : `[vt${i}]`)).join("");
    v.push(`${inputs}concat=n=${n}:v=1:a=${aLabel ? 1 : 0}[vout]${aLabel ? "[aout]" : ""}`);
    outV = "vout";
    outA = aLabel ? "aout" : null;
  }
  const outputMs = segments.reduce((sum, [s, e]) => sum + (e - s), 0);
  return { graph: v.join(";"), videoOut: outV, audioOut: outA, outputMs, segments };
}

export class FfmpegAdapter implements EditorAdapter {
  readonly id = "ffmpeg" as const;
  readonly needsSource = true;
  private plans = new Map<string, Plan>();
  private procs = new Map<string, ChildProcess>();
  private state = new Map<string, "running" | "rendering">();

  async getCapabilities(): Promise<AdapterCapabilities> {
    const ffmpeg = toolVersion(ffmpegBin());
    const ffprobe = toolVersion(ffprobeBin());
    const font = findFont();
    const ops: OpType[] = ffmpeg && ffprobe ? ["clip_trim", "audio_gain", ...(font ? (["text_overlay_add"] as OpType[]) : [])] : [];
    return {
      id: "ffmpeg",
      label: "FFmpeg (flattened render)",
      implemented: Boolean(ffmpeg && ffprobe),
      automated: true,
      supportedOps: ops,
      details: { ffmpeg, ffprobe, font: font ? path.basename(font) : null },
    };
  }

  async inspectProject(ctx: JobContext): Promise<ProjectInspection> {
    const source = path.join(ctx.workDir, "source" + path.extname(ctx.payload.source_version.original_filename || ".mp4").toLowerCase());
    if (!fs.existsSync(source)) throw new Error("Source video was not downloaded");
    const p = probe(source);
    return {
      sourcePath: source,
      durationMs: p.durationMs,
      width: p.width,
      height: p.height,
      frameRate: p.frameRate,
      hasAudio: p.hasAudio,
      notes: [`codec ${p.videoCodec}`, `${p.width}x${p.height}`, `${p.frameRate?.toFixed(2)} fps`, p.hasAudio ? "has audio" : "no audio"],
    };
  }

  validateOperation(op: AgentJobOperation, insp: ProjectInspection) {
    const supported: OpType[] = ["clip_trim", "audio_gain", "text_overlay_add"];
    if (!supported.includes(op.op_type)) return { ok: false, errors: [`FFmpeg adapter does not support ${op.op_type}`] };
    const res = validateOperationShape(op, insp.durationMs);
    const errors = [...res.errors];
    if (op.op_type === "audio_gain" && !insp.hasAudio) errors.push("Source has no audio track");
    if (op.op_type === "text_overlay_add" && !findFont()) errors.push("No font file available for text overlays (set FFMPEG_FONT_FILE)");
    return { ok: errors.length === 0, errors };
  }

  async executeApprovedOperation(op: AgentJobOperation, ctx: JobContext, insp: ProjectInspection): Promise<OperationOutcome> {
    const plan = this.plans.get(ctx.payload.job.id) ?? { overlays: [], gains: [], removes: [], keeps: [] };
    this.plans.set(ctx.payload.job.id, plan);
    this.state.set(ctx.payload.job.id, "running");
    const end = op.end_ms ?? insp.durationMs ?? op.start_ms;
    if (op.op_type === "clip_trim") {
      const p = PARAM_SCHEMAS.clip_trim.parse(op.params);
      (p.mode === "remove_range" ? plan.removes : plan.keeps).push([op.start_ms, end]);
    } else if (op.op_type === "audio_gain") {
      const p = PARAM_SCHEMAS.audio_gain.parse(op.params);
      plan.gains.push({ startMs: op.start_ms, endMs: end, gainDb: p.gain_db });
    } else if (op.op_type === "text_overlay_add") {
      const p = PARAM_SCHEMAS.text_overlay_add.parse(op.params);
      plan.overlays.push({
        text: p.text,
        startMs: op.start_ms,
        endMs: end,
        position: p.position,
        fontPx: Math.max(8, Math.round(((insp.height ?? 1080) * p.font_size_percent) / 100)),
        color: p.color,
      });
    } else {
      throw new NonRetryableError(`Unsupported operation ${op.op_type}`);
    }
    // Planned only: it is applied (and reported done) when the render succeeds.
    return { status: "pending", note: "Planned; applied during render" };
  }

  async finalizeJob(ctx: JobContext, insp: ProjectInspection): Promise<ExecutionResult> {
    const jobId = ctx.payload.job.id;
    const plan = this.plans.get(jobId);
    if (!plan || !insp.sourcePath || !insp.durationMs) throw new NonRetryableError("Nothing to render");
    this.state.set(jobId, "rendering");
    const font = findFont();
    if (plan.overlays.length && !font) throw new NonRetryableError("No font available for text overlays");

    // Work with relative file names inside the job folder (avoids filter path escaping).
    const overlayFiles = plan.overlays.map((o, i) => {
      const name = `overlay_${i}.txt`;
      fs.writeFileSync(path.join(ctx.workDir, name), o.text, "utf8");
      return name;
    });
    if (font) fs.copyFileSync(font, path.join(ctx.workDir, "overlay_font" + path.extname(font)));
    const fontRel = font ? "overlay_font" + path.extname(font) : "";
    const { graph, videoOut, audioOut, outputMs, segments } = buildFilterGraph(
      plan,
      { durationMs: insp.durationMs, hasAudio: Boolean(insp.hasAudio) },
      overlayFiles,
      fontRel,
    );
    await ctx.log("info", `Rendering with FFmpeg: ${plan.overlays.length} overlay(s), ${plan.gains.length} gain change(s), ${segments.length} segment(s).`);
    await ctx.log("debug", "Filter graph", { graph });

    const sourceRel = path.basename(insp.sourcePath);
    const output = "render.mp4";
    const args = [
      "-y",
      "-i", sourceRel,
      ...(graph ? ["-filter_complex", graph, "-map", videoOut.includes(":") ? videoOut : `[${videoOut}]`] : ["-map", "0:v"]),
      ...(audioOut ? ["-map", audioOut.includes(":") ? audioOut : `[${audioOut}]`] : []),
      "-c:v", "libx264", "-preset", process.env.FFMPEG_PRESET ?? "medium", "-crf", process.env.FFMPEG_CRF ?? "18", "-pix_fmt", "yuv420p",
      ...(audioOut ? ["-c:a", "aac", "-b:a", "192k"] : ["-an"]),
      "-movflags", "+faststart",
      output,
    ];
    await runFfmpeg(args, {
      cwd: ctx.workDir,
      totalMs: outputMs,
      signal: ctx.signal,
      onProgress: (f) => ctx.progress(0.2 + f * 0.6, `Rendering ${Math.round(f * 100)}%`),
      onSpawn: (p) => this.procs.set(jobId, p),
    });
    this.procs.delete(jobId);
    const outPath = path.join(ctx.workDir, output);
    const outProbe = probe(outPath);
    if (!outProbe.durationMs || outProbe.durationMs < 100) throw new Error("Render produced an empty video");
    await ctx.log("info", `Render verified: ${(outProbe.durationMs / 1000).toFixed(2)}s, ${outProbe.width}x${outProbe.height}.`);
    this.plans.delete(jobId);
    this.state.delete(jobId);
    return {
      render: { path: outPath, contentType: "video/mp4", filename: `render-job-${jobId.slice(0, 8)}.mp4` },
      summary: `FFmpeg render: ${plan.overlays.length} text overlay(s), ${plan.gains.length} audio change(s), ${plan.removes.length + plan.keeps.length} trim(s).`,
    };
  }

  getJobStatus(jobId: string) {
    const s = this.state.get(jobId);
    return { state: s === "rendering" ? ("rendering" as const) : s ? ("running" as const) : ("idle" as const) };
  }

  async cancelJob(jobId: string) {
    this.procs.get(jobId)?.kill("SIGKILL");
    this.plans.delete(jobId);
    this.state.delete(jobId);
  }
}
