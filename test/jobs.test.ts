import { describe, it, expect, beforeAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EDITOR, freshDb, getDb, getStorage, sampleVideo, setupProjectWithVideo } from "./helpers";
import { createComment } from "@/lib/services/comments";
import { approveProposal, decideOperation, generateProposal, getProposal } from "@/lib/services/proposals";
import {
  cancelJob,
  claimJob,
  completeJob,
  failJob,
  getJob,
  heartbeat,
  presignRenderParts,
  queueJob,
  retryJob,
  startRenderUpload,
} from "@/lib/services/jobs";
import { createRegistration, registerDevice, revokeDevice, type AuthedDevice } from "@/lib/services/devices";
import { listVersions } from "@/lib/services/videos";
import { writePartFile } from "@/lib/storage/local";
import { HttpError } from "@/lib/http";
import { FfmpegAdapter, computeSegments } from "../agent/src/adapters/ffmpeg";
import { probe } from "../agent/src/media";
import type { JobContext } from "../agent/src/adapters/types";

const stream = (buf: Buffer) =>
  new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(new Uint8Array(buf));
      c.close();
    },
  });

async function expectHttp(p: Promise<unknown>, status: number) {
  const err = await p.then(
    () => null,
    (e) => e,
  );
  expect(err).toBeInstanceOf(HttpError);
  expect((err as HttpError).status).toBe(status);
}

async function device(name: string, adapters: string[]): Promise<AuthedDevice> {
  const { code } = await createRegistration(name, EDITOR);
  const reg = await registerDevice(code, { adapters, platform: "test" });
  // registration codes are single use
  await expectHttp(registerDevice(code, { adapters }), 401);
  const db = await getDb();
  const [d] = await db.query<{ adapters: string[] }>("select adapters from agent_devices where id = $1", [reg.deviceId]);
  return { id: reg.deviceId, name, adapters: d!.adapters };
}

/** Uploads a render file through the server-issued multipart URLs (local driver). */
async function uploadRender(dev: AuthedDevice, jobId: string, attempt: number, file: string) {
  const data = fs.readFileSync(file);
  const init = await startRenderUpload(dev, jobId, { attempt, sizeBytes: data.length, contentType: "video/mp4", filename: "render.mp4" });
  const urls = await presignRenderParts(dev, jobId, attempt, Array.from({ length: init.partCount }, (_, i) => i + 1));
  const parts = [];
  for (const [n, url] of Object.entries(urls)) {
    const uploadId = new URL(url).searchParams.get("uploadId")!;
    const chunk = data.subarray((Number(n) - 1) * init.partSize, Number(n) * init.partSize);
    const { etag } = await writePartFile(uploadId, Number(n), stream(chunk));
    parts.push({ partNumber: Number(n), etag });
  }
  return { parts, sizeBytes: data.length, filename: "render.mp4", contentType: "video/mp4" };
}

describe("editing jobs", () => {
  let videoId: string, versionId: string, commentId: string;

  async function approvedProposal(adapter: "ffmpeg" | "manual") {
    const id = await generateProposal(videoId, { versionId, adapter, mode: "offline" }, EDITOR);
    const { proposal } = await getProposal(id);
    const db = await getDb();
    if (adapter === "ffmpeg") {
      // turn the offline manual instruction into a supported automated op, as an editor would
      const { editOperation } = await import("@/lib/services/proposals");
      await editOperation(id, proposal.operations![0]!.id, { op_type: "audio_gain", start_ms: 1000, end_ms: 3000, params: { gain_db: -12 } }, EDITOR);
      for (const o of proposal.operations!.slice(1)) await decideOperation(id, o.id, "rejected", EDITOR);
    }
    for (const o of (await getProposal(id)).proposal.operations!) {
      if (o.decision === "pending") await decideOperation(id, o.id, "approved", EDITOR);
    }
    const fresh = await getProposal(id);
    await approveProposal(id, fresh.proposal.content_hash!, EDITOR);
    void db;
    return id;
  }

  beforeAll(async () => {
    await freshDb();
    ({ videoId, versionId } = await setupProjectWithVideo());
    commentId = await createComment({ videoId, versionId, authorType: "client", authorName: "Sam", body: "Music too loud here", timestampMs: 1500 });
  });

  it("(11) only approved operations are dispatched, after server-side revalidation", async () => {
    const proposalId = await approvedProposal("ffmpeg");
    const ff = await device("Bay 1", ["ffmpeg", "manual", "premiere_pro"]);
    expect(ff.adapters).toEqual(["ffmpeg", "manual"]); // unimplemented adapters are never accepted
    const manualOnly = await device("Laptop", ["manual"]);
    const jobId = await queueJob(proposalId, {}, EDITOR);

    expect(await claimJob(manualOnly)).toBeNull(); // wrong adapter: not dispatched
    const payload = await claimJob(ff);
    expect(payload!.job.id).toBe(jobId);
    expect(payload!.operations).toHaveLength(1);
    expect(payload!.operations[0]!.op_type).toBe("audio_gain");
    expect(payload!.operations[0]!.source_comments[0]!.id).toBe(commentId);
    expect(await claimJob(ff)).toBeNull(); // no duplicate dispatch

    // (14) a successful render becomes a NEW version; the original is preserved
    const render = await uploadRender(ff, jobId, payload!.job.attempt, sampleVideo());
    await expectHttp(completeJob(ff, jobId, { attempt: 99, render }), 409); // stale attempt rejected
    const res = await completeJob(ff, jobId, { attempt: payload!.job.attempt, render, summary: "test render" });
    expect(res.status).toBe("completed");
    const versions = await listVersions(videoId);
    expect(versions.map((v) => v.version_number)).toEqual([2, 1]);
    const v2 = versions[0]!;
    expect(v2.source).toBe("agent_render");
    expect(v2.produced_by_job_id).toBe(jobId);
    expect(v2.produced_by_proposal_id).toBe(proposalId);
    expect(v2.status).toBe("ready");
    const db = await getDb();
    const keys = await db.query<{ storage_key: string }>("select storage_key from video_versions where video_id = $1", [videoId]);
    expect(new Set(keys.map((k) => k.storage_key)).size).toBe(2);
    for (const k of keys) expect(await getStorage().head(k.storage_key)).not.toBeNull();
    const done = await getJob(jobId);
    expect(done.job.status).toBe("completed");
    expect(done.job.result_version_id).toBe(v2.id);
    expect((await getProposal(proposalId)).proposal.status).toBe("completed");
  });

  it("(16) failures, lost leases and retries never produce a false success", async () => {
    // newest version is now v2; analyze it so a new proposal targets it
    const versions = await listVersions(videoId);
    versionId = versions[0]!.id;
    await createComment({ videoId, versionId, authorType: "client", authorName: "Sam", body: "Still loud", timestampMs: 1000 });
    const proposalId = await approvedProposal("ffmpeg");
    const ff = await device("Bay 2", ["ffmpeg"]);
    const jobId = await queueJob(proposalId, {}, EDITOR);

    // attempt 1: agent disappears -> lease expires -> job returns to queue
    const p1 = await claimJob(ff);
    const db = await getDb();
    await db.query("update edit_jobs set lease_expires_at = now() - interval '1 second' where id = $1", [jobId]);
    const p2 = await claimJob(ff);
    expect(p2!.job.attempt).toBe(2);
    // the stale attempt can no longer heartbeat or complete
    await expectHttp(heartbeat(ff, jobId, { attempt: p1!.job.attempt }), 409);

    // attempt 2: retryable failure -> queued again
    expect((await failJob(ff, jobId, { attempt: 2, error: "network blip", retryable: true })).status).toBe("queued");
    // attempt 3: corrupt render -> verification fails -> job failed, no version published
    const p3 = await claimJob(ff);
    expect(p3!.job.attempt).toBe(3);
    const junk = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "rr-junk-")), "junk.mp4");
    fs.writeFileSync(junk, Buffer.alloc(200_000, 7));
    const render = await uploadRender(ff, jobId, 3, junk);
    const res = await completeJob(ff, jobId, { attempt: 3, render });
    expect(res.status).toBe("failed");
    const job = await getJob(jobId);
    expect(job.job.status).toBe("failed");
    expect(job.job.result_version_id).toBeNull();
    const vs = await listVersions(videoId);
    expect(vs.find((v) => v.id === res.version_id)!.status).toBe("failed");
    expect((await getDb().then((d) => d.query<{ current_version_id: string }>("select current_version_id from videos where id = $1", [videoId])))[0]!.current_version_id).toBe(versionId);
    expect((await getProposal(proposalId)).proposal.status).toBe("failed");
    expect(job.logs.some((l) => /verification/.test(l.message))).toBe(true);

    // editor retry re-queues the same approved revision (re-validated at claim time)
    await retryJob(jobId, EDITOR);
    const p4 = await claimJob(ff);
    expect(p4!.job.id).toBe(jobId);
    // cancellation while running is honoured by the agent
    await cancelJob(jobId, EDITOR);
    const hb = await heartbeat(ff, jobId, { attempt: p4!.job.attempt });
    expect(hb.cancel_requested).toBe(true);
    expect((await failJob(ff, jobId, { attempt: p4!.job.attempt, error: "stopped", retryable: false, cancelled: true })).status).toBe("cancelled");

    // revoking a device returns its running jobs to the queue
    await retryJob(jobId, EDITOR);
    await claimJob(ff);
    await revokeDevice(ff.id, EDITOR);
    expect((await getJob(jobId)).job.status).toBe("queued");
  });

  it("(12) the FFmpeg adapter really applies approved operations and renders", async () => {
    const work = fs.mkdtempSync(path.join(os.tmpdir(), "rr-ffmpeg-"));
    fs.copyFileSync(sampleVideo(), path.join(work, "source.mp4"));
    const adapter = new FfmpegAdapter();
    const caps = await adapter.getCapabilities();
    expect(caps.implemented).toBe(true);
    const logs: string[] = [];
    const ctx = {
      payload: {
        job: { id: "00000000-0000-4000-8000-0000000000aa", adapter: "ffmpeg", attempt: 1, max_attempts: 3, lease_expires_at: "", approved_hash: "x" },
        project: { id: "p", name: "p" },
        video: { id: "v", title: "v" },
        source_version: { id: "s", version_number: 1, download_url: "", content_type: "video/mp4", size_bytes: 1, duration_ms: 6000, width: 640, height: 360, frame_rate: 30, original_filename: "source.mp4" },
        operations: [],
      },
      workDir: work,
      signal: new AbortController().signal,
      log: async (_l: string, m: string) => void logs.push(m),
      progress: () => undefined,
      reportOperation: async () => undefined,
      fetchState: async () => ({ status: "running", operations: [] }),
    } as unknown as JobContext;
    const insp = await adapter.inspectProject(ctx);
    expect(insp.durationMs).toBeGreaterThan(5900);
    const ops = [
      { id: "a", op_key: "op_1", op_type: "clip_trim" as const, start_ms: 1000, end_ms: 2000, params: { mode: "remove_range" }, explanation: "", source_comments: [] },
      { id: "b", op_key: "op_2", op_type: "audio_gain" as const, start_ms: 3000, end_ms: 4000, params: { gain_db: -20 }, explanation: "", source_comments: [] },
      ...(caps.supportedOps.includes("text_overlay_add")
        ? [{ id: "c", op_key: "op_3", op_type: "text_overlay_add" as const, start_ms: 0, end_ms: 3000, params: { text: "Bigger headline: 50% off!", position: "top_left", font_size_percent: 8, color: "#FFFFFF" }, explanation: "", source_comments: [] }]
        : []),
    ];
    for (const op of ops) {
      expect(adapter.validateOperation(op, insp)).toEqual({ ok: true, errors: [] });
      expect((await adapter.executeApprovedOperation(op, ctx, insp)).status).toBe("pending"); // planned, not "done"
    }
    // unsupported operations are refused by the adapter
    expect(adapter.validateOperation({ ...ops[0]!, op_type: "layer_move", params: { layer_hint: "x", dx_percent: 1, dy_percent: 0 } }, insp).ok).toBe(false);
    const result = await adapter.finalizeJob(ctx, insp);
    const out = probe(result.render!.path);
    // 1 second removed from a 6 second clip
    expect(Math.abs(out.durationMs! - 5000)).toBeLessThan(150);
    expect(out.width).toBe(640);
    expect(out.hasAudio).toBe(true);
    expect(computeSegments(6000, [], [[1000, 2000]])).toEqual([
      [0, 1000],
      [2000, 6000],
    ]);
  });
});
