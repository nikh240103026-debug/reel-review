import "server-only";
import { getDb, type Queryable } from "@/lib/db";
import { env } from "@/lib/env";
import { randomToken } from "@/lib/crypto";
import { badRequest, conflict, notFound } from "@/lib/http";
import { log } from "@/lib/log";
import { getStorage, choosePartSize, type UploadedPart } from "@/lib/storage";
import { recordActivity } from "./activity";
import { revalidateForExecution } from "./proposals";
import { finalizeProcessing } from "./videos";
import type { AuthedDevice } from "./devices";
import type { JobDTO, JobLogDTO } from "@/shared/dto";
import { ExecutionStatus, type AgentJobPayload, type AdapterId, type OpType } from "@/shared/operations";

const JOB_SELECT = `select j.id, j.proposal_id, j.video_id, v.title as video_title, pr.name as project_name, p.revision as proposal_revision,
  j.source_version_id, j.adapter, j.status, j.target_device_id, td.name as target_device_name, j.claimed_by_device_id,
  cd.name as claimed_by_device_name, j.attempts, j.max_attempts, j.lease_expires_at, j.progress, j.progress_message,
  j.cancel_requested, j.finish_without_render, j.error, j.result_version_id, rv.version_number as result_version_number,
  j.started_at, j.finished_at, j.created_at, j.updated_at
  from edit_jobs j join edit_proposals p on p.id = j.proposal_id join videos v on v.id = j.video_id
  join projects pr on pr.id = v.project_id
  left join agent_devices td on td.id = j.target_device_id left join agent_devices cd on cd.id = j.claimed_by_device_id
  left join video_versions rv on rv.id = j.result_version_id`;

export async function jobLog(q: Queryable, jobId: string, level: JobLogDTO["level"], source: JobLogDTO["source"], message: string, data?: unknown) {
  await q.query("insert into edit_job_logs (job_id, level, source, message, data) values ($1, $2, $3, $4, $5::jsonb)", [
    jobId,
    level,
    source,
    message.slice(0, 4000),
    data === undefined ? null : JSON.stringify(data),
  ]);
}

async function jobContext(q: Queryable, jobId: string) {
  const [j] = await q.query<{ project_id: string; video_id: string; proposal_id: string }>(
    "select v.project_id, j.video_id, j.proposal_id from edit_jobs j join videos v on v.id = j.video_id where j.id = $1",
    [jobId],
  );
  return j;
}

/**
 * Leases that expired are either returned to the queue or, once attempts are
 * exhausted, failed. Never marks anything complete.
 */
export async function sweepExpiredLeases(q: Queryable) {
  const expired = await q.query<{ id: string; attempts: number; max_attempts: number; proposal_id: string }>(
    `select id, attempts, max_attempts, proposal_id from edit_jobs
      where status = 'running' and lease_expires_at < now() for update skip locked`,
  );
  for (const j of expired) {
    if (j.attempts >= j.max_attempts) {
      await q.query(
        `update edit_jobs set status = 'failed', finished_at = now(), lease_expires_at = null,
           error = $2 where id = $1`,
        [j.id, `The editing agent stopped responding (lease expired) after ${j.attempts} attempt(s).`],
      );
      await q.query("update edit_proposals set status = 'failed', status_reason = 'Job failed: agent lease expired' where id = $1", [j.proposal_id]);
      await q.query("update edit_operations set execution_status = 'failed' where proposal_id = $1 and execution_status in ('pending', 'running')", [j.proposal_id]);
      await jobLog(q, j.id, "error", "server", "Lease expired and no attempts remain; job failed.");
    } else {
      await q.query(
        `update edit_jobs set status = 'queued', claimed_by_device_id = null, lease_expires_at = null,
           progress = 0, progress_message = 'Previous attempt interrupted; waiting to retry' where id = $1`,
        [j.id],
      );
      await q.query("update edit_proposals set status = 'queued' where id = $1", [j.proposal_id]);
      await jobLog(q, j.id, "warn", "server", `Lease expired during attempt ${j.attempts}; job returned to the queue.`);
    }
  }
}

// ---------------------------------------------------------------------------
// Editor side
// ---------------------------------------------------------------------------

export async function queueJob(proposalId: string, opts: { deviceId?: string | null }, actor: string): Promise<string> {
  const db = await getDb();
  return db.tx(async (q) => {
    const [p] = await q.query<{ status: string; approved_hash: string | null; adapter: AdapterId; source_version_id: string; video_id: string }>(
      "select status, approved_hash, adapter, source_version_id, video_id from edit_proposals where id = $1 for update",
      [proposalId],
    );
    if (!p) throw notFound("Proposal not found");
    if (!p.approved_hash) throw conflict("Proposal has not been approved. Unapproved operations cannot execute.");
    const idempotencyKey = `${proposalId}:${p.approved_hash}`;
    const [existing] = await q.query<{ id: string; status: string }>("select id, status from edit_jobs where idempotency_key = $1", [idempotencyKey]);
    if (existing) {
      if (existing.status === "queued" || existing.status === "running" || existing.status === "completed") return existing.id;
      throw conflict(`A job for this approval already exists (${existing.status}). Retry it from the job page.`);
    }
    if (p.status !== "approved") throw conflict(`Proposal must be approved to queue (currently ${p.status}).`);

    let deviceAdapters: string[] | undefined;
    if (opts.deviceId) {
      const [d] = await q.query<{ status: string; adapters: string[] }>("select status, adapters from agent_devices where id = $1", [opts.deviceId]);
      if (!d || d.status !== "active") throw badRequest("Selected device is not active");
      deviceAdapters = d.adapters;
    }
    const check = await revalidateForExecution(q, proposalId, {
      approvedHash: p.approved_hash,
      adapter: p.adapter,
      sourceVersionId: p.source_version_id,
      deviceAdapters,
    });
    if (!check.ok) throw conflict(`Cannot queue: ${check.reason}`);

    const [job] = await q.query<{ id: string }>(
      `insert into edit_jobs (proposal_id, video_id, source_version_id, adapter, approved_hash, idempotency_key, target_device_id, max_attempts)
       values ($1, $2, $3, $4, $5, $6, $7, 3) returning id`,
      [proposalId, p.video_id, p.source_version_id, p.adapter, p.approved_hash, idempotencyKey, opts.deviceId ?? null],
    );
    await q.query("update edit_proposals set status = 'queued' where id = $1", [proposalId]);
    await q.query(
      `update edit_operations set execution_status = case when decision = 'approved' then 'pending' else 'skipped' end
        where proposal_id = $1`,
      [proposalId],
    );
    await jobLog(q, job!.id, "info", "server", `Queued by ${actor} for the ${p.adapter} adapter.`, { approved_hash: p.approved_hash });
    const ctx = await jobContext(q, job!.id);
    await recordActivity(q, {
      projectId: ctx?.project_id,
      videoId: p.video_id,
      actorType: "editor",
      actorName: actor,
      eventType: "job.queued",
      data: { job_id: job!.id, proposal_id: proposalId, adapter: p.adapter },
    });
    return job!.id;
  });
}

export async function listJobs(filter: { statuses?: string[]; limit?: number } = {}): Promise<JobDTO[]> {
  const db = await getDb();
  await db.tx((q) => sweepExpiredLeases(q));
  const params: unknown[] = [];
  let where = "";
  if (filter.statuses?.length) {
    params.push(JSON.stringify(filter.statuses));
    where = `where j.status in (select jsonb_array_elements_text($1::jsonb))`;
  }
  params.push(filter.limit ?? 100);
  return db.query<JobDTO>(`${JOB_SELECT} ${where} order by j.created_at desc limit $${params.length}`, params);
}

export async function getJob(jobId: string) {
  const db = await getDb();
  await db.tx((q) => sweepExpiredLeases(q));
  const [job] = await db.query<JobDTO>(`${JOB_SELECT} where j.id = $1`, [jobId]);
  if (!job) throw notFound("Job not found");
  const logs = await db.query<JobLogDTO>(
    "select id, level, source, message, data, created_at from edit_job_logs where job_id = $1 order by created_at, id",
    [jobId],
  );
  const operations = await db.query<{
    id: string;
    op_key: string;
    op_type: string;
    start_ms: number;
    end_ms: number | null;
    params: Record<string, unknown>;
    explanation: string;
    decision: string;
    execution_status: string;
    execution_note: string | null;
  }>(
    `select id, op_key, op_type, start_ms, end_ms, params, explanation, decision, execution_status, execution_note
       from edit_operations where proposal_id = $1 order by position`,
    [job.proposal_id],
  );
  return { job, logs, operations };
}

export async function cancelJob(jobId: string, actor: string) {
  const db = await getDb();
  await db.tx(async (q) => {
    const [j] = await q.query<{ status: string; proposal_id: string }>("select status, proposal_id from edit_jobs where id = $1 for update", [jobId]);
    if (!j) throw notFound("Job not found");
    if (j.status === "queued") {
      await q.query("update edit_jobs set status = 'cancelled', finished_at = now(), error = 'Cancelled by editor' where id = $1", [jobId]);
      // the approval itself stays valid; the revision can be queued again
      await q.query("update edit_proposals set status = 'approved' where id = $1 and status = 'queued'", [j.proposal_id]);
      await q.query("update edit_operations set execution_status = 'not_started' where proposal_id = $1", [j.proposal_id]);
      await jobLog(q, jobId, "warn", "editor", `Cancelled by ${actor} before execution.`);
    } else if (j.status === "running") {
      await q.query("update edit_jobs set cancel_requested = true where id = $1", [jobId]);
      await jobLog(q, jobId, "warn", "editor", `Cancellation requested by ${actor}; waiting for the agent to stop.`);
    } else {
      throw conflict(`Job is already ${j.status}`);
    }
  });
}

/** Retry a failed/cancelled job of the same approved revision (re-validated at claim time). */
export async function retryJob(jobId: string, actor: string) {
  const db = await getDb();
  await db.tx(async (q) => {
    const [j] = await q.query<{ status: string; proposal_id: string; approved_hash: string }>(
      "select status, proposal_id, approved_hash from edit_jobs where id = $1 for update",
      [jobId],
    );
    if (!j) throw notFound("Job not found");
    if (j.status !== "failed" && j.status !== "cancelled") throw conflict(`Only failed or cancelled jobs can be retried (job is ${j.status}).`);
    const [p] = await q.query<{ approved_hash: string | null; status: string }>("select approved_hash, status from edit_proposals where id = $1", [
      j.proposal_id,
    ]);
    if (!p || p.approved_hash !== j.approved_hash || p.status === "cancelled") {
      throw conflict("The proposal revision behind this job is no longer approved. Approve a new revision instead.");
    }
    await q.query(
      `update edit_jobs set status = 'queued', attempts = 0, error = null, cancel_requested = false, lease_expires_at = null,
         claimed_by_device_id = null, progress = 0, progress_message = null, finished_at = null, render_storage_key = null,
         render_upload_id = null, finish_without_render = false
       where id = $1`,
      [jobId],
    );
    await q.query("update edit_proposals set status = 'queued', status_reason = null where id = $1", [j.proposal_id]);
    await q.query(
      `update edit_operations set execution_status = case when decision = 'approved' then 'pending' else 'skipped' end, execution_note = null
        where proposal_id = $1`,
      [j.proposal_id],
    );
    await jobLog(q, jobId, "info", "editor", `Retry requested by ${actor}.`);
  });
}

/** Manual adapter: the editor ticks off checklist tasks in the web app. */
export async function setManualTask(jobId: string, opId: string, done: boolean, actor: string) {
  const db = await getDb();
  await db.tx(async (q) => {
    const [j] = await q.query<{ status: string; adapter: string; proposal_id: string }>(
      "select status, adapter, proposal_id from edit_jobs where id = $1 for update",
      [jobId],
    );
    if (!j) throw notFound("Job not found");
    if (j.adapter !== "manual") throw badRequest("Only manual-adapter jobs have checklist tasks");
    if (j.status !== "running") throw conflict("Checklist tasks can be updated while the job is running on the agent");
    const [op] = await q.query<{ op_key: string; decision: string }>("select op_key, decision from edit_operations where id = $1 and proposal_id = $2", [
      opId,
      j.proposal_id,
    ]);
    if (!op || op.decision !== "approved") throw notFound("Task not found");
    await q.query("update edit_operations set execution_status = $2, execution_note = $3 where id = $1", [
      opId,
      done ? "manual_done" : "manual_pending",
      done ? `Marked done by ${actor}` : null,
    ]);
    await jobLog(q, jobId, "info", "editor", `${actor} marked ${op.op_key} as ${done ? "done" : "not done"}.`);
  });
}

/** Manual adapter: finish when every task is done but no new render is needed. */
export async function finishManualWithoutRender(jobId: string, actor: string) {
  const db = await getDb();
  await db.tx(async (q) => {
    const [j] = await q.query<{ status: string; adapter: string; proposal_id: string }>(
      "select status, adapter, proposal_id from edit_jobs where id = $1 for update",
      [jobId],
    );
    if (!j) throw notFound("Job not found");
    if (j.adapter !== "manual" || j.status !== "running") throw conflict("Only running manual jobs can be finished this way");
    const [{ open }] = (await q.query<{ open: number }>(
      "select count(*)::int as open from edit_operations where proposal_id = $1 and decision = 'approved' and execution_status <> 'manual_done'",
      [j.proposal_id],
    )) as [{ open: number }];
    if (open > 0) throw conflict(`${open} checklist task(s) are not marked done yet`);
    await q.query(
      `update edit_jobs set status = 'completed', finished_at = now(), progress = 1, lease_expires_at = null, finish_without_render = true,
         progress_message = 'Completed manually without a new render' where id = $1`,
      [jobId],
    );
    await q.query("update edit_proposals set status = 'completed', status_reason = 'Manual tasks completed; no new render uploaded' where id = $1", [
      j.proposal_id,
    ]);
    await jobLog(q, jobId, "info", "editor", `${actor} completed the job without uploading a new render.`);
    const ctx = await jobContext(q, jobId);
    await recordActivity(q, {
      projectId: ctx?.project_id,
      videoId: ctx?.video_id,
      actorType: "editor",
      actorName: actor,
      eventType: "job.completed",
      data: { job_id: jobId, proposal_id: j.proposal_id, render: false },
    });
  });
}

/**
 * Links a manually uploaded revision to a job. Running/queued manual jobs are
 * completed by it; a failed job stays failed (the agent did not succeed), but
 * the version records which proposal it addresses.
 */
export async function attachManualRevision(jobId: string, versionId: string, actor: string) {
  const db = await getDb();
  await db.tx(async (q) => {
    const [j] = await q.query<{ status: string; adapter: string; proposal_id: string }>(
      "select status, adapter, proposal_id from edit_jobs where id = $1 for update",
      [jobId],
    );
    if (!j) throw notFound("Job not found");
    const [v] = await q.query<{ status: string; version_number: number }>("select status, version_number from video_versions where id = $1", [versionId]);
    if (!v || v.status !== "ready") throw conflict("The uploaded revision is not ready");
    if (j.adapter === "manual" && (j.status === "running" || j.status === "queued")) {
      await q.query(
        `update edit_jobs set status = 'completed', finished_at = now(), progress = 1, result_version_id = $2, lease_expires_at = null,
           progress_message = 'Completed with a manually uploaded revision' where id = $1`,
        [jobId, versionId],
      );
      await q.query("update edit_proposals set status = 'completed', status_reason = null where id = $1", [j.proposal_id]);
      await jobLog(q, jobId, "info", "editor", `${actor} uploaded revision v${v.version_number}; job completed.`);
    } else {
      await jobLog(q, jobId, "info", "editor", `${actor} uploaded manual revision v${v.version_number} for this proposal (job status unchanged: ${j.status}).`);
    }
  });
}

// ---------------------------------------------------------------------------
// Agent side
// ---------------------------------------------------------------------------

async function lockClaimedJob(q: Queryable, device: AuthedDevice, jobId: string, attempt?: number) {
  const [j] = await q.query<{
    id: string;
    status: string;
    claimed_by_device_id: string | null;
    attempts: number;
    proposal_id: string;
    adapter: string;
    cancel_requested: boolean;
    video_id: string;
    source_version_id: string;
    render_storage_key: string | null;
    render_upload_id: string | null;
    approved_hash: string;
  }>(
    `select id, status, claimed_by_device_id, attempts, proposal_id, adapter, cancel_requested, video_id, source_version_id,
            render_storage_key, render_upload_id, approved_hash
       from edit_jobs where id = $1 for update`,
    [jobId],
  );
  if (!j) throw notFound("Job not found");
  if (j.claimed_by_device_id !== device.id) throw conflict("This job is not held by this device");
  if (attempt !== undefined && attempt !== j.attempts) throw conflict("Stale attempt: the job was reassigned");
  return j;
}

export async function claimJob(device: AuthedDevice): Promise<AgentJobPayload | null> {
  const db = await getDb();
  for (let i = 0; i < 5; i++) {
    const result = await db.tx(async (q): Promise<AgentJobPayload | null | "retry"> => {
      await sweepExpiredLeases(q);
      const [job] = await q.query<{
        id: string;
        proposal_id: string;
        adapter: string;
        approved_hash: string;
        source_version_id: string;
        attempts: number;
        max_attempts: number;
      }>(
        `select id, proposal_id, adapter, approved_hash, source_version_id, attempts, max_attempts from edit_jobs
          where status = 'queued' and cancel_requested = false
            and (target_device_id is null or target_device_id = $1)
            and adapter in (select jsonb_array_elements_text($2::jsonb))
          order by created_at
          for update skip locked limit 1`,
        [device.id, JSON.stringify(device.adapters)],
      );
      if (!job) return null;

      const check = await revalidateForExecution(q, job.proposal_id, {
        approvedHash: job.approved_hash,
        adapter: job.adapter,
        sourceVersionId: job.source_version_id,
        deviceAdapters: device.adapters,
      });
      if (!check.ok) {
        await q.query("update edit_jobs set status = 'failed', finished_at = now(), error = $2 where id = $1", [
          job.id,
          `Revalidation failed before execution: ${check.reason}`,
        ]);
        await q.query("update edit_proposals set status = 'failed', status_reason = $2 where id = $1 and status in ('queued', 'running')", [
          job.proposal_id,
          `Revalidation failed: ${check.reason}`,
        ]);
        await jobLog(q, job.id, "error", "server", `Refused to dispatch: ${check.reason}`);
        return "retry";
      }

      const attempt = job.attempts + 1;
      const [leased] = await q.query<{ lease_expires_at: string }>(
        `update edit_jobs set status = 'running', claimed_by_device_id = $2, attempts = $3, started_at = coalesce(started_at, now()),
           lease_expires_at = now() + make_interval(secs => $4::double precision), progress = 0, progress_message = 'Claimed by agent'
         where id = $1 returning lease_expires_at`,
        [job.id, device.id, attempt, env.jobLeaseSeconds],
      );
      await q.query("update edit_proposals set status = 'running' where id = $1", [job.proposal_id]);
      await q.query(
        "update edit_operations set execution_status = 'pending' where proposal_id = $1 and decision = 'approved' and execution_status <> 'manual_done'",
        [job.proposal_id],
      );
      await jobLog(q, job.id, "info", "server", `Claimed by device "${device.name}" (attempt ${attempt}/${job.max_attempts}). Revalidation passed.`);

      const [ctx] = await q.query<{
        project_id: string;
        project_name: string;
        video_id: string;
        video_title: string;
        version_number: number;
        storage_key: string;
        content_type: string;
        size_bytes: number;
        duration_ms: number | null;
        width: number | null;
        height: number | null;
        frame_rate: number | null;
        original_filename: string;
      }>(
        `select pr.id as project_id, pr.name as project_name, v.id as video_id, v.title as video_title, vv.version_number, vv.storage_key,
                vv.content_type, vv.size_bytes, vv.duration_ms, vv.width, vv.height, vv.frame_rate, vv.original_filename
           from video_versions vv join videos v on v.id = vv.video_id join projects pr on pr.id = v.project_id where vv.id = $1`,
        [job.source_version_id],
      );
      const commentIds = [...new Set(check.operations.flatMap((o) => o.source_comment_ids))];
      const comments = commentIds.length
        ? await q.query<{ id: string; author_name: string; body: string; timestamp_ms: number | null }>(
            "select id, author_name, body, timestamp_ms from comments where id in (select (jsonb_array_elements_text($1::jsonb))::uuid)",
            [JSON.stringify(commentIds)],
          )
        : [];
      const execStatus = await q.query<{ id: string; execution_status: string }>(
        "select id, execution_status from edit_operations where proposal_id = $1",
        [job.proposal_id],
      );
      return {
        job: {
          id: job.id,
          adapter: job.adapter as AdapterId,
          attempt,
          max_attempts: job.max_attempts,
          lease_expires_at: leased!.lease_expires_at,
          approved_hash: job.approved_hash,
        },
        project: { id: ctx!.project_id, name: ctx!.project_name },
        video: { id: ctx!.video_id, title: ctx!.video_title },
        source_version: {
          id: job.source_version_id,
          version_number: ctx!.version_number,
          download_url: await getStorage().presignGet(ctx!.storage_key, { expiresIn: 6 * 3600 }),
          content_type: ctx!.content_type,
          size_bytes: ctx!.size_bytes,
          duration_ms: ctx!.duration_ms,
          width: ctx!.width,
          height: ctx!.height,
          frame_rate: ctx!.frame_rate,
          original_filename: ctx!.original_filename,
        },
        operations: check.operations.map((o) => ({
          id: o.id,
          op_key: o.op_key,
          op_type: o.op_type as OpType,
          start_ms: o.start_ms,
          end_ms: o.end_ms,
          params: o.params,
          explanation: o.explanation,
          execution_status: execStatus.find((e) => e.id === o.id)?.execution_status,
          source_comments: comments.filter((c) => o.source_comment_ids.includes(c.id)),
        })),
      };
    });
    if (result !== "retry") return result;
  }
  return null;
}

export async function heartbeat(device: AuthedDevice, jobId: string, input: { attempt: number; progress?: number; message?: string }) {
  const db = await getDb();
  return db.tx(async (q) => {
    const j = await lockClaimedJob(q, device, jobId, input.attempt);
    if (j.status !== "running") return { status: j.status, cancel_requested: j.cancel_requested, lease_expires_at: null };
    const [row] = await q.query<{ lease_expires_at: string }>(
      `update edit_jobs set lease_expires_at = now() + make_interval(secs => $2::double precision),
         progress = coalesce($3, progress), progress_message = coalesce($4, progress_message)
       where id = $1 returning lease_expires_at`,
      [jobId, env.jobLeaseSeconds, input.progress === undefined ? null : Math.min(1, Math.max(0, input.progress)), input.message?.slice(0, 300) ?? null],
    );
    const ops = await q.query<{ id: string; execution_status: string }>(
      "select id, execution_status from edit_operations where proposal_id = $1 and decision = 'approved'",
      [j.proposal_id],
    );
    return { status: j.status, cancel_requested: j.cancel_requested, lease_expires_at: row!.lease_expires_at, operations: ops };
  });
}

export async function appendAgentLogs(
  device: AuthedDevice,
  jobId: string,
  entries: { level: JobLogDTO["level"]; message: string; data?: unknown }[],
) {
  const db = await getDb();
  await db.tx(async (q) => {
    await lockClaimedJob(q, device, jobId);
    for (const e of entries.slice(0, 50)) await jobLog(q, jobId, e.level, "agent", e.message, e.data);
  });
}

export async function reportOperationStatus(
  device: AuthedDevice,
  jobId: string,
  attempt: number,
  updates: { op_id: string; status: string; note?: string | null }[],
) {
  const db = await getDb();
  await db.tx(async (q) => {
    const j = await lockClaimedJob(q, device, jobId, attempt);
    if (j.status !== "running") throw conflict(`Job is ${j.status}`);
    for (const u of updates) {
      const parsed = ExecutionStatus.safeParse(u.status);
      if (!parsed.success) throw badRequest(`Invalid execution status ${u.status}`);
      if (parsed.data === "manual_done") throw badRequest("Only the editor can mark manual tasks done");
      await q.query(
        `update edit_operations set execution_status = $3, execution_note = $4
          where id = $1 and proposal_id = $2 and decision = 'approved' and execution_status <> 'manual_done'`,
        [u.op_id, j.proposal_id, parsed.data, u.note?.slice(0, 1000) ?? null],
      );
    }
  });
}

export async function startRenderUpload(
  device: AuthedDevice,
  jobId: string,
  input: { attempt: number; sizeBytes: number; contentType: string; filename: string },
) {
  if (input.sizeBytes <= 0 || input.sizeBytes > env.maxUploadBytes) throw badRequest("Invalid render size");
  if (!/^video\//.test(input.contentType)) throw badRequest("Render must be a video");
  const db = await getDb();
  const storage = getStorage();
  return db.tx(async (q) => {
    const j = await lockClaimedJob(q, device, jobId, input.attempt);
    if (j.status !== "running") throw conflict(`Job is ${j.status}`);
    if (j.cancel_requested) throw conflict("Job cancellation was requested");
    const [ctx] = await q.query<{ project_id: string }>("select project_id from videos where id = $1", [j.video_id]);
    const ext = (input.filename.split(".").pop() ?? "mp4").toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 5) || "mp4";
    const key = `projects/${ctx!.project_id}/videos/${j.video_id}/renders/job-${jobId}-a${j.attempts}-${randomToken(6)}/render.${ext}`;
    if (j.render_upload_id && j.render_storage_key) {
      await storage.abortMultipart(j.render_storage_key, j.render_upload_id).catch(() => undefined);
    }
    const { uploadId } = await storage.createMultipart(key, input.contentType);
    const partSize = choosePartSize(input.sizeBytes);
    await q.query("update edit_jobs set render_storage_key = $2, render_upload_id = $3 where id = $1", [jobId, key, uploadId]);
    await jobLog(q, jobId, "info", "server", `Render upload started (${(input.sizeBytes / 1024 / 1024).toFixed(1)} MB).`);
    return { uploadId, partSize, partCount: Math.ceil(input.sizeBytes / partSize), sizeBytes: input.sizeBytes, contentType: input.contentType };
  });
}

export async function presignRenderParts(device: AuthedDevice, jobId: string, attempt: number, partNumbers: number[]) {
  const db = await getDb();
  const j = await db.tx((q) => lockClaimedJob(q, device, jobId, attempt));
  if (!j.render_storage_key || !j.render_upload_id) throw conflict("No render upload in progress");
  const storage = getStorage();
  const urls: Record<number, string> = {};
  for (const n of partNumbers.slice(0, 100)) {
    if (!Number.isInteger(n) || n < 1 || n > 10_000) throw badRequest("Invalid part number");
    urls[n] = await storage.presignPart(j.render_storage_key, j.render_upload_id, n, 3600);
  }
  return urls;
}

/**
 * Completion from the agent. For automated adapters a render is mandatory and
 * is verified in storage before a new version is created; a job is only
 * marked completed if the new version is verified ready.
 */
export async function completeJob(
  device: AuthedDevice,
  jobId: string,
  input: {
    attempt: number;
    render?: { parts: UploadedPart[]; sizeBytes: number; filename: string; contentType: string } | null;
    summary?: string;
  },
) {
  const db = await getDb();
  const storage = getStorage();
  const j = await db.tx((q) => lockClaimedJob(q, device, jobId, input.attempt));
  if (j.status !== "running") throw conflict(`Job is ${j.status}`);
  if (j.cancel_requested) throw conflict("Job cancellation was requested; report cancellation instead");

  if (!input.render) {
    throw j.adapter === "manual"
      ? conflict("Manual jobs without a new render are finished by the editor in the web app")
      : badRequest("Automated adapters must upload a render to complete a job");
  }

  if (!j.render_storage_key || !j.render_upload_id) throw conflict("No render upload in progress");
  const key = j.render_storage_key;
  try {
    await storage.completeMultipart(key, j.render_upload_id, input.render.parts);
  } catch (err) {
    throw conflict(`Storage rejected the render upload: ${(err as Error).message}`);
  }
  const head = await storage.head(key);
  if (!head || head.size !== input.render.sizeBytes) {
    await db.tx((q) =>
      jobLog(q, jobId, "error", "server", `Render verification failed: expected ${input.render!.sizeBytes} bytes, found ${head?.size ?? 0}.`),
    );
    throw conflict("Render verification failed (size mismatch). Upload it again.");
  }

  // Create the new version (originals and previous versions are untouched).
  const versionId = await db.tx(async (q) => {
    await q.query("select id from videos where id = $1 for update", [j.video_id]);
    const [{ next }] = (await q.query<{ next: number }>(
      "select coalesce(max(version_number), 0) + 1 as next from video_versions where video_id = $1",
      [j.video_id],
    )) as [{ next: number }];
    const [v] = await q.query<{ id: string }>(
      `insert into video_versions (video_id, version_number, status, source, storage_key, original_filename, content_type, size_bytes,
         produced_by_job_id, produced_by_proposal_id, notes, browser_playable)
       values ($1, $2, 'processing', 'agent_render', $3, $4, $5, $6, $7, $8, $9, null) returning id`,
      [
        j.video_id,
        next,
        key,
        input.render!.filename.slice(0, 500),
        input.render!.contentType,
        input.render!.sizeBytes,
        jobId,
        j.proposal_id,
        input.summary?.slice(0, 2000) ?? `Rendered by ${device.name} (${j.adapter})`,
      ],
    );
    await q.query("update edit_jobs set render_upload_id = null where id = $1", [jobId]);
    await jobLog(q, jobId, "info", "server", `Render stored as version v${next}; verifying.`);
    return v!.id;
  });

  const status = await finalizeProcessing(versionId, device.name, "agent");
  if (status !== "ready") {
    await db.tx(async (q) => {
      await q.query("update edit_jobs set status = 'failed', finished_at = now(), lease_expires_at = null, error = $2 where id = $1", [
        jobId,
        "The uploaded render failed verification and was not published.",
      ]);
      await q.query("update edit_proposals set status = 'failed', status_reason = 'Render failed verification' where id = $1", [j.proposal_id]);
      await jobLog(q, jobId, "error", "server", "Render failed verification; job marked failed.");
    });
    return { status: "failed" as const, version_id: versionId };
  }

  await db.tx(async (q) => {
    await q.query(
      `update edit_jobs set status = 'completed', finished_at = now(), progress = 1, lease_expires_at = null, result_version_id = $2,
         progress_message = 'Completed' where id = $1`,
      [jobId, versionId],
    );
    await q.query("update edit_proposals set status = 'completed', status_reason = null where id = $1", [j.proposal_id]);
    await q.query(
      `update edit_operations set execution_status = 'done' where proposal_id = $1 and decision = 'approved' and execution_status in ('pending', 'running')`,
      [j.proposal_id],
    );
    await jobLog(q, jobId, "info", "server", "Job completed; new version is ready for review.");
    const ctx = await jobContext(q, jobId);
    await recordActivity(q, {
      projectId: ctx?.project_id,
      videoId: j.video_id,
      actorType: "agent",
      actorName: device.name,
      eventType: "job.completed",
      data: { job_id: jobId, proposal_id: j.proposal_id, version_id: versionId },
    });
  });
  log.info("job.completed", { job_id: jobId, version_id: versionId });
  return { status: "completed" as const, version_id: versionId };
}

export async function failJob(
  device: AuthedDevice,
  jobId: string,
  input: { attempt: number; error: string; retryable: boolean; cancelled?: boolean },
) {
  const db = await getDb();
  const storage = getStorage();
  const result = await db.tx(async (q) => {
    const j = await lockClaimedJob(q, device, jobId, input.attempt);
    if (j.status !== "running") throw conflict(`Job is ${j.status}`);
    const [meta] = await q.query<{ attempts: number; max_attempts: number }>("select attempts, max_attempts from edit_jobs where id = $1", [jobId]);
    const message = input.error.slice(0, 2000);
    if (input.cancelled || j.cancel_requested) {
      await q.query(
        "update edit_jobs set status = 'cancelled', finished_at = now(), lease_expires_at = null, error = $2 where id = $1",
        [jobId, j.cancel_requested ? "Cancelled by editor" : message],
      );
      await q.query("update edit_proposals set status = 'approved' where id = $1 and status = 'running'", [j.proposal_id]);
      await q.query("update edit_operations set execution_status = 'not_started' where proposal_id = $1 and execution_status <> 'manual_done'", [j.proposal_id]);
      await jobLog(q, jobId, "warn", "agent", `Stopped: ${message}`);
      return { status: "cancelled", upload: j.render_upload_id ? { key: j.render_storage_key!, id: j.render_upload_id } : null };
    }
    if (input.retryable && meta!.attempts < meta!.max_attempts) {
      await q.query(
        `update edit_jobs set status = 'queued', claimed_by_device_id = null, lease_expires_at = null, error = $2,
           progress = 0, progress_message = 'Waiting to retry' where id = $1`,
        [jobId, message],
      );
      await q.query("update edit_proposals set status = 'queued' where id = $1", [j.proposal_id]);
      await jobLog(q, jobId, "warn", "agent", `Attempt ${meta!.attempts} failed (will retry): ${message}`);
      return { status: "queued", upload: j.render_upload_id ? { key: j.render_storage_key!, id: j.render_upload_id } : null };
    }
    await q.query("update edit_jobs set status = 'failed', finished_at = now(), lease_expires_at = null, error = $2 where id = $1", [jobId, message]);
    await q.query("update edit_proposals set status = 'failed', status_reason = $2 where id = $1", [j.proposal_id, `Job failed: ${message.slice(0, 300)}`]);
    await q.query(
      "update edit_operations set execution_status = 'failed' where proposal_id = $1 and execution_status in ('pending', 'running')",
      [j.proposal_id],
    );
    await jobLog(q, jobId, "error", "agent", `Job failed: ${message}`);
    const ctx = await jobContext(q, jobId);
    await recordActivity(q, {
      projectId: ctx?.project_id,
      videoId: j.video_id,
      actorType: "agent",
      actorName: device.name,
      eventType: "job.failed",
      data: { job_id: jobId, proposal_id: j.proposal_id, error: message.slice(0, 300) },
    });
    return { status: "failed", upload: j.render_upload_id ? { key: j.render_storage_key!, id: j.render_upload_id } : null };
  });
  if (result.upload) {
    await storage.abortMultipart(result.upload.key, result.upload.id).catch(() => undefined);
    await db.query("update edit_jobs set render_upload_id = null where id = $1", [jobId]);
  }
  return { status: result.status };
}

export async function getAgentJobState(device: AuthedDevice, jobId: string) {
  const db = await getDb();
  const [j] = await db.query<{ status: string; cancel_requested: boolean; finish_without_render: boolean; claimed_by_device_id: string | null; proposal_id: string; attempts: number }>(
    "select status, cancel_requested, finish_without_render, claimed_by_device_id, proposal_id, attempts from edit_jobs where id = $1",
    [jobId],
  );
  if (!j || j.claimed_by_device_id !== device.id) throw notFound("Job not found");
  const ops = await db.query<{ id: string; op_key: string; execution_status: string }>(
    "select id, op_key, execution_status from edit_operations where proposal_id = $1 and decision = 'approved' order by position",
    [j.proposal_id],
  );
  return { status: j.status, attempt: j.attempts, cancel_requested: j.cancel_requested, finish_without_render: j.finish_without_render, operations: ops };
}
