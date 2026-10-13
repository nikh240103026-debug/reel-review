/**
 * End-to-end test over real HTTP against a production build (`npm run build` first).
 * Starts an isolated server (temporary database + storage, port 3100), then
 * exercises editor, guest and agent flows, including the real agent CLI with
 * the FFmpeg adapter. Usage: npm run build && npm run e2e
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const PORT = Number(process.env.E2E_PORT ?? 3100);
const BASE = `http://localhost:${PORT}`;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "reelreview-e2e-"));
const ACCESS_KEY = crypto.randomBytes(18).toString("base64url");
const serverEnv: NodeJS.ProcessEnv = {
  ...process.env,
  NODE_ENV: "production",
  PORT: String(PORT),
  APP_URL: BASE,
  APP_SECRET: crypto.randomBytes(40).toString("base64url"),
  EDITOR_ACCESS_KEY: ACCESS_KEY,
  EDITOR_DISPLAY_NAME: "E2E Editor",
  DATABASE_URL: "",
  STORAGE_DRIVER: "local",
  PGLITE_DATA_DIR: path.join(tmp, "db"),
  LOCAL_STORAGE_DIR: path.join(tmp, "storage"),
  ANTHROPIC_API_KEY: "",
  GEMINI_API_KEY: "",
  JOB_LEASE_SECONDS: "60",
};

let passed = 0;
const results: string[] = [];
function check(cond: unknown, label: string): asserts cond {
  if (!cond) throw new Error(`FAILED: ${label}`);
  passed += 1;
  results.push(`  ✓ ${label}`);
}

let cookie = "";
async function http(method: string, p: string, body?: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(BASE + p, {
    method,
    redirect: "manual",
    headers: { ...(body !== undefined ? { "Content-Type": "application/json" } : {}), ...(cookie ? { Cookie: cookie } : {}), ...headers },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json: any = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  return { status: res.status, json, headers: res.headers };
}
const as = (c: string) => ({ editor: c });

async function waitForServer(proc: ChildProcess) {
  for (let i = 0; i < 120; i++) {
    if (proc.exitCode !== null) throw new Error("Server exited early");
    try {
      const r = await fetch(`${BASE}/api/health`);
      if (r.ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("Server did not start");
}

function makeSample(file: string) {
  const r = spawnSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=640x360:rate=30:duration=6", "-f", "lavfi", "-i", "sine=frequency=440:duration=6", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-preset", "ultrafast", "-c:a", "aac", "-shortest", file], { windowsHide: true });
  if (r.status !== 0) throw new Error("ffmpeg is required for the e2e test");
}

async function uploadViaHttp(projectId: string, file: string, videoId?: string) {
  const data = fs.readFileSync(file);
  const start = await http("POST", "/api/editor/uploads", { projectId, videoId, filename: path.basename(file), contentType: "video/mp4", sizeBytes: data.length });
  check(start.status === 201, `upload session created (direct-to-storage, part size ${start.json?.partSize})`);
  const { versionId, partSize, partCount } = start.json;
  const nums = Array.from({ length: partCount }, (_, i) => i + 1);
  const urls = (await http("POST", `/api/editor/uploads/${versionId}/parts`, { partNumbers: nums })).json.urls as Record<string, string>;
  const parts = [];
  for (const n of nums) {
    const res = await fetch(urls[n]!, { method: "PUT", body: data.subarray((n - 1) * partSize, n * partSize) });
    parts.push({ partNumber: n, etag: res.headers.get("etag")! });
  }
  check(parts.every((p) => p.etag), "parts PUT straight to signed storage URLs");
  const forged = await fetch(urls[1]!.replace(/sig=[^&]+/, "sig=forged"), { method: "PUT", body: "x" });
  check(forged.status === 403, "storage URL with a forged signature is rejected");
  const done = await http("POST", `/api/editor/uploads/${versionId}/complete`, { parts, metadata: { browserPlayable: true } });
  check(done.status === 200 && done.json.version.status === "ready", "upload verified and version ready");
  return { versionId, videoId: done.json.version.video_id as string, version: done.json.version };
}

async function main() {
  if (!fs.existsSync(".next/BUILD_ID")) throw new Error("Run `npm run build` first");
  const sample = path.join(tmp, "cut.mp4");
  makeSample(sample);
  const server = spawn(process.execPath, ["node_modules/next/dist/bin/next", "start", "-p", String(PORT)], { env: serverEnv, stdio: ["ignore", "pipe", "pipe"] });
  let serverLog = "";
  server.stdout!.on("data", (d) => (serverLog += d));
  server.stderr!.on("data", (d) => (serverLog += d));
  try {
    await waitForServer(server);
    console.log(`Isolated server on ${BASE} (data in ${tmp})`);

    // --- Editor access -------------------------------------------------
    check((await http("GET", "/api/editor/projects")).status === 401, "editor API refuses requests without a session");
    const page = await fetch(`${BASE}/dashboard`, { redirect: "manual" });
    check(page.status === 307 && page.headers.get("location")!.includes("/unlock"), "editor pages redirect to /unlock");
    check((await http("POST", "/api/editor-session", { accessKey: "wrong-key-wrong-key" })).status === 401, "wrong editor access key rejected");
    const unlock = await http("POST", "/api/editor-session", { accessKey: ACCESS_KEY });
    cookie = unlock.headers.get("set-cookie")!.split(";")[0]!;
    check(unlock.status === 200 && unlock.headers.get("set-cookie")!.toLowerCase().includes("httponly"), "access key exchanged for HttpOnly session cookie");
    const xorigin = await http("POST", "/api/editor/projects", { name: "x" }, { Origin: "https://evil.example" });
    check(xorigin.status === 403, "cross-origin state change rejected (CSRF guard)");

    // --- (1) project + upload ----------------------------------------------
    const proj = await http("POST", "/api/editor/projects", { name: "E2E Spring Promo" });
    check(proj.status === 201, "(1) editor created a project");
    const projectId = proj.json.id as string;
    const up = await uploadViaHttp(projectId, sample);
    const videoId = up.videoId;

    // --- review link + guest -----------------------------------------------
    const linkRes = await http("POST", `/api/editor/projects/${projectId}/links`, { videoId, canComment: true });
    const link = linkRes.json.link;
    const token = (link.url as string).split("/r/")[1]!;
    const saved = cookie;
    cookie = ""; // from here: a guest with no account and no editor session
    const guestKey = crypto.randomBytes(18).toString("base64url");
    const g = { "x-guest-key": guestKey };
    const overview = await http("GET", `/api/review/${token}`);
    check(overview.status === 200 && overview.json.videos.length === 1, "(2) guest opens a valid review link without an account");
    const guestPage = await fetch(`${BASE}/r/${token}/v/${videoId}`);
    check(guestPage.status === 200, "(2) guest review page renders");
    const view = await http("GET", `/api/review/${token}/videos/${videoId}`, undefined, g);
    const v1 = view.json.versions[0];
    check(view.json.permissions.is_editor === false && v1.playback_url, "guest receives an expiring signed media URL");
    const range = await fetch(v1.playback_url, { headers: { Range: "bytes=0-1023" } });
    check(range.status === 206 && range.headers.get("content-range")!.startsWith("bytes 0-1023/"), "video streaming supports HTTP Range (seeking)");
    await range.arrayBuffer();

    const noName = await http("POST", `/api/review/${token}/videos/${videoId}/comments`, { versionId: v1.id, body: "hi", timestampMs: 1000 }, g);
    check(noName.status === 400, "comment without a display name is refused");
    check((await http("POST", `/api/review/${token}/identity`, { guestKey, displayName: "Alex" })).status === 200, "guest display name recorded");
    const posted = await http(
      "POST",
      `/api/review/${token}/videos/${videoId}/comments`,
      { versionId: v1.id, body: "Music is too loud here, and add a 'NEW' label top left.", timestampMs: 2400, authorName: "Alex", annotation: { strokes: [{ color: "#FF4D4F", width: 0.004, points: [[0.1, 0.1], [0.3, 0.2]] }] } },
      g,
    );
    check(posted.status === 201, "guest comment posted");
    const listed = await http("GET", `/api/review/${token}/videos/${videoId}/comments?versionId=${v1.id}`, undefined, g);
    const c0 = listed.json.comments[0];
    check(c0.author_name === "Alex" && c0.author_type === "client" && c0.timestamp_ms === 2400 && c0.video_version_id === v1.id, "(5) comment shows the entered name, integer ms timestamp and version");
    check(c0.attachments[0]?.kind === "annotation", "frame annotation stored with the comment");

    // --- (7)(8) guest boundaries --------------------------------------------
    const p2 = (await (async () => {
      cookie = saved;
      const r = await http("POST", "/api/editor/projects", { name: "Other client" });
      const other = await uploadViaHttp(r.json.id, sample);
      cookie = "";
      return other;
    })());
    check((await http("GET", `/api/review/${token}/videos/${p2.videoId}`, undefined, g)).status === 404, "(7) link cannot reach videos outside its scope");
    check((await http("GET", `/api/review/${"x".repeat(43)}`)).status === 404, "(7) unknown token refused");
    check((await http("GET", `/api/editor/proposals`, undefined, g)).status === 401, "(8) guests cannot list proposals");
    check((await http("POST", `/api/editor/videos/${videoId}/ai-review`, { versionId: v1.id, adapter: "ffmpeg", mode: "offline" }, g)).status === 401, "(8) guests cannot run AI review");
    check((await http("POST", `/api/agent/jobs/claim`, {}, g)).status === 401, "(8) guests cannot claim or execute jobs");

    // --- AI proposal + approval ---------------------------------------------
    cookie = saved;
    const aiCheck = await http("POST", `/api/editor/videos/${videoId}/ai-review`, { versionId: v1.id, adapter: "ffmpeg", mode: "ai" });
    check(aiCheck.status === 409 && /not configured/.test(aiCheck.json.error), "AI mode refuses honestly when no API key is configured");
    const gen = await http("POST", `/api/editor/videos/${videoId}/ai-review`, { versionId: v1.id, adapter: "ffmpeg", mode: "offline" });
    check(gen.status === 201, "offline draft proposal generated (labelled not-AI)");
    const pid = gen.json.proposalId as string;
    let prop = (await http("GET", `/api/editor/proposals/${pid}`)).json;
    check(prop.proposal.generator === "offline_rules" && prop.proposal.operations[0].validation_status === "unsupported", "(13) manual instruction marked unsupported for the FFmpeg adapter");
    const op = prop.proposal.operations[0];
    check((await http("POST", `/api/editor/proposals/${pid}/operations/${op.id}`, { action: "decide", decision: "approved" })).status === 409, "(13) unsupported operation cannot be approved");
    // editor rewrites it into two supported operations? one op per row: edit to audio gain
    const edited = await http("PATCH", `/api/editor/proposals/${pid}/operations/${op.id}`, { op_type: "audio_gain", start_ms: 1500, end_ms: 3500, params: { gain_db: -12 } });
    check(edited.status === 200 && edited.json.validation.status === "valid", "editor edited the operation into a valid audio gain");
    await http("POST", `/api/editor/proposals/${pid}/operations/${op.id}`, { action: "decide", decision: "approved" });
    prop = (await http("GET", `/api/editor/proposals/${pid}`)).json;
    const stale = prop.proposal.content_hash;
    await http("PATCH", `/api/editor/proposals/${pid}/operations/${op.id}`, { params: { gain_db: -10 } });
    check((await http("POST", `/api/editor/proposals/${pid}`, { action: "approve", contentHash: stale })).status === 409, "(10) approval of a stale revision hash is refused after an edit");
    check((await http("POST", `/api/editor/proposals/${pid}`, { action: "queue" })).status === 409, "(11) unapproved proposal cannot be queued");
    await http("POST", `/api/editor/proposals/${pid}/operations/${op.id}`, { action: "decide", decision: "approved" });
    prop = (await http("GET", `/api/editor/proposals/${pid}`)).json;
    const appr = await http("POST", `/api/editor/proposals/${pid}`, { action: "approve", contentHash: prop.proposal.content_hash });
    check(appr.status === 200 && appr.json.approved_hash === prop.proposal.content_hash, "revision approved, bound to its content hash");
    check((await http("PATCH", `/api/editor/proposals/${pid}/operations/${op.id}`, { params: { gain_db: -3 } })).status === 409, "(10) approved revision is frozen");

    // --- device registration + real agent ----------------------------------
    const reg = await http("POST", "/api/editor/devices", { name: "E2E Edit Bay" });
    const agentCfg = path.join(tmp, "agent-config.json");
    const agentEnv = { ...process.env, REELREVIEW_AGENT_CONFIG: agentCfg };
    const tsx = path.join("node_modules", "tsx", "dist", "cli.mjs");
    const r1 = spawnSync(process.execPath, [tsx, "agent/src/cli.ts", "register", "--server", BASE, "--code", reg.json.code, "--work-dir", path.join(tmp, "jobs")], { env: agentEnv, encoding: "utf8" });
    check(r1.status === 0 && fs.existsSync(agentCfg), "agent registered with a one-time code");
    const queued = await http("POST", `/api/editor/proposals/${pid}`, { action: "queue" });
    check(queued.status === 201, "approved proposal queued");
    const jobId = queued.json.jobId as string;
    const r2 = spawnSync(process.execPath, [tsx, "agent/src/cli.ts", "start", "--once"], { env: agentEnv, encoding: "utf8", timeout: 240_000 });
    process.stdout.write(r2.stdout.split("\n").map((l) => `    agent | ${l}`).join("\n") + "\n");
    const job = (await http("GET", `/api/editor/jobs/${jobId}`)).json;
    check(job.job.status === "completed" && job.job.result_version_id, "(12) agent executed the approved operation with FFmpeg");

    // --- (14) new version, original preserved ---------------------------------
    const ev = (await http("GET", `/api/editor/videos/${videoId}`)).json;
    check(ev.versions.length === 2 && ev.versions[0].version_number === 2 && ev.versions[0].source === "agent_render", "(14) render created v2");
    check(ev.versions[1].id === v1.id && ev.versions[1].status === "ready", "(14) original v1 preserved");
    const dl1 = await http("GET", `/api/editor/videos/${videoId}/download?versionId=${v1.id}`);
    const orig = await fetch(dl1.json.url);
    check(Buffer.from(await orig.arrayBuffer()).equals(fs.readFileSync(sample)), "(14) original file byte-for-byte unchanged");
    check(ev.versions[0].produced_by_proposal_id === pid && ev.versions[0].produced_by_job_id === jobId, "(14) v2 records the proposal and job that produced it");

    // guest can review the new draft
    cookie = "";
    const gv = (await http("GET", `/api/review/${token}/videos/${videoId}`, undefined, g)).json;
    check(gv.video.current_version_id === ev.versions[0].id, "client sees the new draft as the latest version");
    const c2 = await http("POST", `/api/review/${token}/videos/${videoId}/comments`, { versionId: ev.versions[0].id, body: "Better! Approved.", timestampMs: 500, authorName: "Alex" }, g);
    check(c2.status === 201, "client commented on the new draft");
    const v1comments = (await http("GET", `/api/review/${token}/videos/${videoId}/comments?versionId=${v1.id}`, undefined, g)).json.comments;
    check(v1comments.length === 1 && v1comments[0].timestamp_ms === 2400, "old comments stay on v1 at their original timestamp");

    // --- (15) revocation ------------------------------------------------------
    cookie = saved;
    await http("PATCH", `/api/editor/links/${link.id}`, { revoke: true });
    cookie = "";
    check((await http("GET", `/api/review/${token}/videos/${videoId}`, undefined, g)).status === 410, "(15) revoked link stops granting access immediately");
    const rp = await fetch(`${BASE}/r/${token}`);
    check(rp.status === 200 && (await rp.text()).includes("no longer active"), "(15) revoked link page explains the link is inactive");

    // device revocation
    cookie = saved;
    await http("DELETE", `/api/editor/devices/${(await http("GET", "/api/editor/devices")).json.devices[0].id}`);
    const r3 = spawnSync(process.execPath, [tsx, "agent/src/cli.ts", "start", "--once"], { env: agentEnv, encoding: "utf8", timeout: 60_000 });
    check(/revoked or unknown/.test(r3.stdout), "revoked device token is rejected by the server");

    console.log(results.join("\n"));
    console.log(`\nE2E PASSED: ${passed} checks`);
  } catch (err) {
    console.log(results.join("\n"));
    console.error(`\n${(err as Error).message}`);
    console.error("--- server log (tail) ---\n" + serverLog.slice(-3000));
    process.exitCode = 1;
  } finally {
    server.kill();
    await new Promise((r) => setTimeout(r, 500));
    try {
      fs.rmSync(tmp, { recursive: true, force: true });
    } catch {
      /* files may still be locked on Windows */
    }
  }
}

main();
