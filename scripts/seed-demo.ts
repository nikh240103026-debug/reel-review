/**
 * Creates a demo project over HTTP: a generated test clip, a review link and a
 * few client comments. Requires ffmpeg and a running server.
 *   SEED_BASE=http://localhost:3000 npm run seed   (reads EDITOR_ACCESS_KEY from .env.local)
 */
import { loadEnvConfig } from "@next/env";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

loadEnvConfig(process.cwd());
const BASE = process.env.SEED_BASE ?? process.env.APP_URL ?? "http://localhost:3000";
const KEY = process.env.SEED_ACCESS_KEY ?? process.env.EDITOR_ACCESS_KEY;

async function main() {
  if (!KEY) throw new Error("EDITOR_ACCESS_KEY not found");
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "rr-seed-")), "demo-cut.mp4");
  const r = spawnSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=1280x720:rate=30:duration=20", "-f", "lavfi", "-i", "sine=frequency=330:duration=20", "-vf", "drawtext=text='SUMMER SALE':fontsize=64:fontcolor=white:x=(w-text_w)/2:y=h*0.15:fontfile=" + (process.platform === "win32" ? "C\\\\:/Windows/Fonts/arial.ttf" : "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"), "-c:v", "libx264", "-pix_fmt", "yuv420p", "-preset", "veryfast", "-c:a", "aac", "-shortest", file], { windowsHide: true });
  if (r.status !== 0) {
    // fall back to a clip without text if no font is available
    spawnSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=1280x720:rate=30:duration=20", "-f", "lavfi", "-i", "sine=frequency=330:duration=20", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-preset", "veryfast", "-c:a", "aac", "-shortest", file], { windowsHide: true });
  }
  const s = await fetch(`${BASE}/api/editor-session`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ accessKey: KEY }) });
  if (!s.ok) throw new Error(`Unlock failed (${s.status})`);
  const cookie = s.headers.get("set-cookie")!.split(";")[0]!;
  const call = async (p: string, body?: unknown, method = "POST") => {
    const res = await fetch(BASE + p, { method, headers: { "Content-Type": "application/json", Cookie: cookie }, body: body ? JSON.stringify(body) : undefined });
    const json = await res.json();
    if (!res.ok) throw new Error(`${p}: ${json.error}`);
    return json;
  };
  const { id: projectId } = await call("/api/editor/projects", { name: "Demo: Summer Sale spot", description: "Seeded demo project" });
  const data = fs.readFileSync(file);
  const up = await call("/api/editor/uploads", { projectId, title: "Summer Sale 20s", filename: "summer-sale.mp4", contentType: "video/mp4", sizeBytes: data.length });
  const { urls } = await call(`/api/editor/uploads/${up.versionId}/parts`, { partNumbers: Array.from({ length: up.partCount }, (_, i) => i + 1) });
  const parts = [];
  for (let n = 1; n <= up.partCount; n++) {
    const res = await fetch(urls[n], { method: "PUT", body: data.subarray((n - 1) * up.partSize, n * up.partSize) });
    parts.push({ partNumber: n, etag: res.headers.get("etag") });
  }
  const { version } = await call(`/api/editor/uploads/${up.versionId}/complete`, { parts, metadata: { browserPlayable: true } });
  const { link } = await call(`/api/editor/projects/${projectId}/links`, { videoId: version.video_id, canComment: true, label: "Client review" });
  const token = link.url.split("/r/")[1];
  const guest = { "Content-Type": "application/json", "x-guest-key": "seedguestkey_0123456789" };
  for (const [t, body] of [
    [2400, "Make this headline bigger and move it to the left."],
    [7800, "The music is too loud between 7 and 10 seconds."],
    [15200, "Can we make the ending pop more?"],
  ] as const) {
    await fetch(`${BASE}/api/review/${token}/videos/${version.video_id}/comments`, {
      method: "POST",
      headers: guest,
      body: JSON.stringify({ versionId: version.id, body, timestampMs: t, authorName: "Jordan (Client)" }),
    });
  }
  console.log(`Project: ${BASE}/projects/${projectId}`);
  console.log(`Review link: ${link.url}`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
