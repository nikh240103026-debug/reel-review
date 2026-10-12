import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { openDb, runMigrations, setDbForTests, getDb } from "@/lib/db";
import { setStorageForTests, getStorage } from "@/lib/storage";
import { writePartFile } from "@/lib/storage/local";
import { createProject } from "@/lib/services/projects";
import { startUpload, completeUpload } from "@/lib/services/videos";
import type { VideoVersionDTO } from "@/shared/dto";

export const EDITOR = "Test Editor";

export async function freshDb() {
  const p = (async () => {
    const db = await openDb();
    await runMigrations(db);
    return db;
  })();
  setDbForTests(p);
  setStorageForTests(undefined);
  return p;
}

export function ffmpegAvailable(): boolean {
  return spawnSync("ffmpeg", ["-version"], { windowsHide: true }).status === 0;
}

let sample: string | null = null;
/** A real 6-second H.264/AAC test clip generated with ffmpeg (cached per run). */
export function sampleVideo(): string {
  if (sample) return sample;
  const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "rr-sample-")), "sample.mp4");
  const res = spawnSync(
    "ffmpeg",
    [
      "-v", "error", "-y",
      "-f", "lavfi", "-i", "testsrc2=size=640x360:rate=30:duration=6",
      "-f", "lavfi", "-i", "sine=frequency=440:duration=6",
      "-c:v", "libx264", "-pix_fmt", "yuv420p", "-preset", "ultrafast",
      "-c:a", "aac", "-shortest", "-movflags", "+faststart",
      out,
    ],
    { windowsHide: true },
  );
  if (res.status !== 0) throw new Error(`ffmpeg failed: ${res.stderr?.toString()}`);
  sample = out;
  return out;
}

function streamOf(buf: Buffer): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(c) {
      c.enqueue(new Uint8Array(buf));
      c.close();
    },
  });
}

/** Uploads a file through the real multipart flow (local storage driver). */
export async function uploadFile(projectId: string, file: string, opts: { videoId?: string; skipComplete?: boolean; partsToSend?: number } = {}) {
  const data = fs.readFileSync(file);
  const started = await startUpload(
    { projectId, videoId: opts.videoId, filename: path.basename(file), contentType: "video/mp4", sizeBytes: data.length },
    EDITOR,
  );
  const db = await getDb();
  const [row] = await db.query<{ upload_id: string }>("select upload_id from video_versions where id = $1", [started.versionId]);
  const parts = [];
  const limit = opts.partsToSend ?? started.partCount;
  for (let n = 1; n <= limit; n++) {
    const chunk = data.subarray((n - 1) * started.partSize, n * started.partSize);
    const { etag } = await writePartFile(row!.upload_id, n, streamOf(chunk));
    parts.push({ partNumber: n, etag });
  }
  if (opts.skipComplete) return { ...started, parts, version: undefined };
  const version: VideoVersionDTO | undefined = await completeUpload(started.versionId, { parts, metadata: { browserPlayable: true } }, EDITOR);
  return { ...started, parts, version };
}

export async function setupProjectWithVideo(name = "Spring Campaign") {
  const projectId = await createProject({ name }, EDITOR);
  const up = await uploadFile(projectId, sampleVideo());
  return { projectId, videoId: up.videoId, versionId: up.versionId, upload: up };
}

export { getDb, getStorage };
