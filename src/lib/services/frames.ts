import "server-only";
import { spawn } from "node:child_process";
import { log } from "@/lib/log";

let ffmpegAvailable: boolean | undefined;

function bin() {
  return process.env.FFMPEG_PATH?.trim() || "ffmpeg";
}

export async function isFfmpegAvailable(): Promise<boolean> {
  if (ffmpegAvailable !== undefined) return ffmpegAvailable;
  ffmpegAvailable = await new Promise<boolean>((resolve) => {
    try {
      const p = spawn(/*turbopackIgnore: true*/ bin(), ["-version"], { windowsHide: true });
      p.on("error", () => resolve(false));
      p.on("close", (code) => resolve(code === 0));
    } catch {
      resolve(false);
    }
  });
  return ffmpegAvailable;
}

/**
 * Optional: extracts a JPEG still at a timestamp so Claude can see what the
 * commenter saw. Requires ffmpeg on the server; returns null otherwise.
 */
export async function extractFrameJpeg(input: string, timestampMs: number, maxWidth = 768): Promise<Buffer | null> {
  if (!(await isFfmpegAvailable())) return null;
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    const args = [
      "-v", "error",
      "-ss", (timestampMs / 1000).toFixed(3),
      "-i", input,
      "-frames:v", "1",
      "-vf", `scale='min(${maxWidth},iw)':-2`,
      "-f", "image2pipe",
      "-vcodec", "mjpeg",
      "-q:v", "5",
      "pipe:1",
    ];
    const p = spawn(/*turbopackIgnore: true*/ bin(), args, { windowsHide: true });
    const timer = setTimeout(() => p.kill("SIGKILL"), 20_000);
    p.stdout.on("data", (d: Buffer) => chunks.push(d));
    p.on("error", () => {
      clearTimeout(timer);
      resolve(null);
    });
    p.on("close", (code) => {
      clearTimeout(timer);
      const buf = Buffer.concat(chunks);
      if (code !== 0 || buf.length === 0) {
        log.warn("frames.extract_failed", { timestampMs, code });
        resolve(null);
      } else resolve(buf);
    });
  });
}
