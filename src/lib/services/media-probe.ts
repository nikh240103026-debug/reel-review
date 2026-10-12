import "server-only";
import { spawn } from "node:child_process";
import { env } from "@/lib/env";
import { log } from "@/lib/log";

export interface ProbeResult {
  durationMs: number | null;
  width: number | null;
  height: number | null;
  frameRate: number | null;
  videoCodec: string | null;
  audioCodec: string | null;
  hasAudio: boolean;
}

let ffprobeAvailable: boolean | undefined;

function ffprobeBin() {
  return env.ffprobePath ?? "ffprobe";
}

function run(bin: string, args: string[], timeoutMs: number): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let child;
    try {
      child = spawn(/*turbopackIgnore: true*/ bin, args, { windowsHide: true });
    } catch {
      resolve({ code: -1, stdout, stderr: "spawn failed" });
      return;
    }
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", () => {
      clearTimeout(timer);
      resolve({ code: -1, stdout, stderr: "spawn error" });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

export async function isFfprobeAvailable(): Promise<boolean> {
  if (ffprobeAvailable === undefined) {
    const res = await run(ffprobeBin(), ["-version"], 5000);
    ffprobeAvailable = res.code === 0;
  }
  return ffprobeAvailable;
}

function parseRate(rate: string | undefined): number | null {
  if (!rate) return null;
  const [n, d] = rate.split("/").map(Number);
  if (!n || !d) return null;
  const v = n / d;
  return Number.isFinite(v) && v > 0 && v < 1000 ? Math.round(v * 1000) / 1000 : null;
}

/** Best-effort server-side probe (optional; requires ffprobe on the server). */
export async function probeMedia(input: string): Promise<ProbeResult | { error: string }> {
  if (!(await isFfprobeAvailable())) return { error: "ffprobe not available" };
  const res = await run(
    ffprobeBin(),
    ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", input],
    30_000,
  );
  if (res.code !== 0) {
    const msg = res.stderr.split("\n").filter(Boolean).slice(-2).join(" ").slice(0, 300) || "ffprobe failed";
    log.warn("media.probe_failed", { message: msg });
    return { error: msg };
  }
  try {
    const data = JSON.parse(res.stdout) as {
      streams?: { codec_type?: string; codec_name?: string; width?: number; height?: number; avg_frame_rate?: string; r_frame_rate?: string; duration?: string }[];
      format?: { duration?: string };
    };
    const v = data.streams?.find((s) => s.codec_type === "video");
    const a = data.streams?.find((s) => s.codec_type === "audio");
    if (!v) return { error: "No video stream found" };
    const dur = Number(data.format?.duration ?? v.duration);
    return {
      durationMs: Number.isFinite(dur) ? Math.round(dur * 1000) : null,
      width: v.width ?? null,
      height: v.height ?? null,
      frameRate: parseRate(v.avg_frame_rate) ?? parseRate(v.r_frame_rate),
      videoCodec: v.codec_name ?? null,
      audioCodec: a?.codec_name ?? null,
      hasAudio: Boolean(a),
    };
  } catch {
    return { error: "Could not parse ffprobe output" };
  }
}
