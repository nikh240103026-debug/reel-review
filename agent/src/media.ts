import fs from "node:fs";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";

export const ffmpegBin = () => process.env.FFMPEG_PATH?.trim() || "ffmpeg";
export const ffprobeBin = () => process.env.FFPROBE_PATH?.trim() || "ffprobe";

export function toolVersion(bin: string): string | null {
  try {
    const res = spawnSync(bin, ["-version"], { windowsHide: true, timeout: 10_000 });
    if (res.status !== 0) return null;
    return res.stdout.toString().split("\n")[0]?.trim() ?? "unknown";
  } catch {
    return null;
  }
}

export interface Probe {
  durationMs: number | null;
  width: number | null;
  height: number | null;
  frameRate: number | null;
  hasAudio: boolean;
  videoCodec: string | null;
}

export function probe(file: string): Probe {
  const res = spawnSync(ffprobeBin(), ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", file], {
    windowsHide: true,
    timeout: 60_000,
    maxBuffer: 10 * 1024 * 1024,
  });
  if (res.status !== 0) throw new Error(`ffprobe failed: ${res.stderr?.toString().slice(-300)}`);
  const data = JSON.parse(res.stdout.toString()) as {
    streams?: { codec_type?: string; codec_name?: string; width?: number; height?: number; avg_frame_rate?: string }[];
    format?: { duration?: string };
  };
  const v = data.streams?.find((s) => s.codec_type === "video");
  if (!v) throw new Error("Source has no video stream");
  const [n, d] = (v.avg_frame_rate ?? "0/1").split("/").map(Number);
  const dur = Number(data.format?.duration);
  return {
    durationMs: Number.isFinite(dur) ? Math.round(dur * 1000) : null,
    width: v.width ?? null,
    height: v.height ?? null,
    frameRate: n && d ? n / d : null,
    hasAudio: Boolean(data.streams?.some((s) => s.codec_type === "audio")),
    videoCodec: v.codec_name ?? null,
  };
}

const FONT_CANDIDATES = [
  "C:/Windows/Fonts/arial.ttf",
  "C:/Windows/Fonts/segoeui.ttf",
  "/System/Library/Fonts/Supplemental/Arial.ttf",
  "/Library/Fonts/Arial.ttf",
  "/System/Library/Fonts/Helvetica.ttc",
  "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
  "/usr/share/fonts/dejavu/DejaVuSans.ttf",
  "/usr/share/fonts/TTF/DejaVuSans.ttf",
];

/** drawtext needs a font file; text overlays are only advertised if one exists. */
export function findFont(): string | null {
  const configured = process.env.FFMPEG_FONT_FILE?.trim();
  if (configured && fs.existsSync(configured)) return configured;
  return FONT_CANDIDATES.find((f) => fs.existsSync(f)) ?? null;
}

/** Runs ffmpeg (no shell) and reports progress from `-progress pipe:1`. */
export function runFfmpeg(
  args: string[],
  opts: { cwd: string; totalMs: number; signal: AbortSignal; onProgress: (fraction: number) => void; onSpawn?: (p: ChildProcess) => void },
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegBin(), ["-hide_banner", "-nostats", "-progress", "pipe:1", ...args], {
      cwd: opts.cwd,
      windowsHide: true,
    });
    opts.onSpawn?.(child);
    let stderr = "";
    const onAbort = () => child.kill("SIGKILL");
    opts.signal.addEventListener("abort", onAbort, { once: true });
    child.stdout.on("data", (buf: Buffer) => {
      for (const line of buf.toString().split("\n")) {
        const m = /^out_time_us=(\d+)/.exec(line.trim()) ?? /^out_time_ms=(\d+)/.exec(line.trim());
        if (m && opts.totalMs > 0) opts.onProgress(Math.min(1, Number(m[1]) / 1000 / opts.totalMs));
      }
    });
    child.stderr.on("data", (d: Buffer) => {
      stderr = (stderr + d.toString()).slice(-4000);
    });
    child.on("error", (err) => {
      opts.signal.removeEventListener("abort", onAbort);
      reject(err);
    });
    child.on("close", (code) => {
      opts.signal.removeEventListener("abort", onAbort);
      if (opts.signal.aborted) reject(new Error("ffmpeg stopped (job cancelled)"));
      else if (code === 0) resolve();
      else reject(new Error(`ffmpeg exited with code ${code}: ${stderr.split("\n").filter(Boolean).slice(-3).join(" | ")}`));
    });
  });
}
