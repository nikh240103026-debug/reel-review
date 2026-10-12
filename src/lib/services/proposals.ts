import "server-only";
import { getDb, type Queryable } from "@/lib/db";
import { canonicalJson, sha256Hex } from "@/lib/crypto";
import { env } from "@/lib/env";
import { HttpError, badRequest, conflict, notFound } from "@/lib/http";
import { log } from "@/lib/log";
import { getStorage } from "@/lib/storage";
import { analyzeWithClaude, AiError } from "@/lib/ai/claude";
import { offlineDraft } from "@/lib/ai/offline";
import { describeAnnotation, type ReviewComment, type ReviewInput } from "@/lib/ai/prompt";
import type { WireOperationT, WireProposalT } from "@/lib/ai/schema";
import { recordActivity } from "./activity";
import { createComment } from "./comments";
import { extractFrameJpeg } from "./frames";
import {
  ADAPTERS,
  ADAPTER_IDS,
  OP_TYPES,
  adapterSupports,
  compatibilityFor,
  validateOperationShape,
  type AdapterId,
  type OpType,
} from "@/shared/operations";
import type { AnnotationStroke, OperationDTO, ProposalDTO, ProposalStatus } from "@/shared/dto";

/** States in which the editor may still edit and decide operations. */
export const EDITABLE_STATES: ProposalStatus[] = ["draft", "validated", "awaiting_approval", "needs_clarification"];
/** States in which the approved revision is frozen. */
export const FROZEN_STATES: ProposalStatus[] = ["approved", "queued", "running", "completed", "failed"];

export function isAdapterId(v: string): v is AdapterId {
  return (ADAPTER_IDS as readonly string[]).includes(v);
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export interface OpForValidation {
  op_type: string;
  start_ms: number;
  end_ms: number | null;
  params: unknown;
  source_comment_ids: string[];
  needs_clarification: boolean;
}

export function validateOperation(
  op: OpForValidation,
  ctx: { adapter: AdapterId; durationMs: number | null; knownCommentIds: Set<string> },
): { status: OperationDTO["validation_status"]; errors: string[] } {
  const shape = validateOperationShape(op, ctx.durationMs);
  const errors = [...shape.errors];
  const unknown = op.source_comment_ids.filter((id) => !ctx.knownCommentIds.has(id));
  if (unknown.length) errors.push(`References comment(s) not in the source version: ${unknown.join(", ")}`);
  if (op.source_comment_ids.length === 0) errors.push("Operation must reference at least one source comment");
  if (errors.length) return { status: "invalid", errors };
  if (op.needs_clarification) return { status: "needs_clarification", errors: [] };
  if (!adapterSupports(ctx.adapter, op.op_type as OpType)) {
    return { status: "unsupported", errors: [`${ADAPTERS[ctx.adapter].label} cannot execute ${op.op_type}`] };
  }
  return { status: "valid", errors: [] };
}

interface OpRow {
  id: string;
  op_key: string;
  position: number;
  op_type: string;
  start_ms: number;
  end_ms: number | null;
  params: Record<string, unknown>;
  decision: string;
  source_comment_ids: string[];
  validation_status: string;
  needs_clarification: boolean;
}

export function computeContentHash(p: { source_version_id: string; adapter: string }, ops: OpRow[]): string {
  const material = {
    source_version_id: p.source_version_id,
    adapter: p.adapter,
    operations: [...ops]
      .sort((a, b) => a.position - b.position)
      .map((o) => ({
        op_key: o.op_key,
        op_type: o.op_type,
        start_ms: o.start_ms,
        end_ms: o.end_ms,
        params: o.params,
        decision: o.decision,
        source_comment_ids: [...o.source_comment_ids].sort(),
      })),
  };
  return sha256Hex(canonicalJson(material));
}

async function loadOps(q: Queryable, proposalId: string): Promise<OpRow[]> {
  return q.query<OpRow>(
    `select id, op_key, position, op_type, start_ms, end_ms, params, decision, source_comment_ids, validation_status, needs_clarification
       from edit_operations where proposal_id = $1 order by position`,
    [proposalId],
  );
}

/** Recomputes content hash and the pre-approval status after any change. */
async function refreshDraftState(q: Queryable, proposalId: string) {
  const [p] = await q.query<{ source_version_id: string; adapter: string; status: ProposalStatus }>(
    "select source_version_id, adapter, status from edit_proposals where id = $1",
    [proposalId],
  );
  if (!p) throw notFound("Proposal not found");
  const ops = await loadOps(q, proposalId);
  const hash = computeContentHash(p, ops);
  const live = ops.filter((o) => o.decision !== "rejected");
  const status: ProposalStatus = live.some((o) => o.validation_status === "needs_clarification")
    ? "needs_clarification"
    : "awaiting_approval";
  await q.query("update edit_proposals set content_hash = $2, status = $3 where id = $1", [proposalId, hash, status]);
  return { hash, status };
}

// ---------------------------------------------------------------------------
// Generation
// ---------------------------------------------------------------------------

async function buildReviewInput(versionId: string, adapter: AdapterId) {
  const db = await getDb();
  const [ctx] = await db.query<{
    video_id: string;
    video_title: string;
    project_id: string;
    project_name: string;
    project_description: string | null;
    version_number: number;
    status: string;
    duration_ms: number | null;
    width: number | null;
    height: number | null;
    frame_rate: number | null;
    has_audio: boolean | null;
    storage_key: string;
  }>(
    `select v.id as video_id, v.title as video_title, p.id as project_id, p.name as project_name, p.description as project_description,
            vv.version_number, vv.status, vv.duration_ms, vv.width, vv.height, vv.frame_rate, vv.has_audio, vv.storage_key
       from video_versions vv join videos v on v.id = vv.video_id join projects p on p.id = v.project_id
      where vv.id = $1`,
    [versionId],
  );
  if (!ctx) throw notFound("Version not found");
  if (ctx.status !== "ready") throw conflict("The selected version is not ready");

  const rows = await db.query<{
    id: string;
    parent_id: string | null;
    author_name: string;
    author_type: string;
    body: string;
    timestamp_ms: number | null;
    status: string;
  }>(
    `select id, parent_id, author_name, author_type, body, timestamp_ms, status from comments
      where video_version_id = $1 order by created_at`,
    [versionId],
  );
  const annotations = await db.query<{ comment_id: string; data: { strokes?: AnnotationStroke[] } }>(
    `select a.comment_id, a.data from comment_attachments a join comments c on c.id = a.comment_id
      where c.video_version_id = $1 and a.kind = 'annotation'`,
    [versionId],
  );
  const openTop = rows.filter((r) => !r.parent_id && r.status === "open" && r.author_type !== "ai");
  const comments: ReviewComment[] = openTop.map((c) => ({
    id: c.id,
    author_name: c.author_name,
    author_type: c.author_type,
    timestamp_ms: c.timestamp_ms,
    body: c.body,
    annotation_regions: annotations.filter((a) => a.comment_id === c.id).flatMap((a) => describeAnnotation(a.data?.strokes)),
    replies: rows
      .filter((r) => r.parent_id === c.id)
      .map((r) => ({ id: r.id, author_name: r.author_name, author_type: r.author_type, body: r.body })),
  }));
  const input: ReviewInput = {
    project: { name: ctx.project_name, description: ctx.project_description },
    video: { title: ctx.video_title },
    source_version: {
      id: versionId,
      version_number: ctx.version_number,
      duration_ms: ctx.duration_ms,
      width: ctx.width,
      height: ctx.height,
      frame_rate: ctx.frame_rate,
      has_audio: ctx.has_audio,
    },
    adapter,
    comments,
    frames_attached: [],
  };
  return { ctx, input };
}

export async function generateProposal(
  videoId: string,
  opts: { versionId: string; adapter: string; mode: "claude" | "offline" },
  actor: string,
): Promise<string> {
  if (!isAdapterId(opts.adapter) || !ADAPTERS[opts.adapter].implemented) {
    throw badRequest(`Adapter "${opts.adapter}" is not available`);
  }
  const adapter = opts.adapter;
  const { ctx, input } = await buildReviewInput(opts.versionId, adapter);
  if (ctx.video_id !== videoId) throw notFound("Version does not belong to this video");
  if (input.comments.length === 0) throw conflict("There are no unresolved comments on this version to analyze.");

  let wire: WireProposalT;
  let model: string | null = null;
  let raw: unknown = null;
  if (opts.mode === "claude") {
    if (!env.anthropicConfigured) {
      throw conflict("Claude is not configured (ANTHROPIC_API_KEY missing). Use the offline draft or add a key.");
    }
    // Attach stills at comment timestamps when the server has ffmpeg.
    const frames: { mediaType: "image/jpeg"; data: string }[] = [];
    const source = await getStorage().localPathOrUrl(ctx.storage_key);
    for (const c of input.comments.slice(0, 12)) {
      if (c.timestamp_ms === null) continue;
      const jpg = await extractFrameJpeg(source, c.timestamp_ms);
      if (jpg) {
        frames.push({ mediaType: "image/jpeg", data: jpg.toString("base64") });
        input.frames_attached.push({ comment_id: c.id, timestamp_ms: c.timestamp_ms });
      }
    }
    try {
      const res = await analyzeWithClaude(input, frames);
      wire = res.proposal;
      model = res.model;
      raw = { proposal: res.proposal, usage: res.usage, stop_reason: res.stop_reason };
    } catch (err) {
      if (err instanceof AiError) {
        log.warn("ai.analysis_failed", { message: err.message, retryable: err.retryable });
        throw new HttpError(502, err.message, err.retryable ? "ai_retryable" : "ai_error");
      }
      throw err;
    }
  } else {
    wire = offlineDraft(input);
    raw = { generator: "offline_rules" };
  }

  const knownIds = new Set(input.comments.map((c) => c.id));
  const db = await getDb();
  const proposalId = await db.tx(async (q) => {
    const [p] = await q.query<{ id: string }>(
      `insert into edit_proposals (video_id, source_version_id, revision, status, adapter, generator, model, summary,
         comment_coverage, input_snapshot, raw_response)
       values ($1, $2, 1, 'draft', $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9::jsonb) returning id`,
      [
        videoId,
        opts.versionId,
        adapter,
        opts.mode === "claude" ? "claude" : "offline_rules",
        model,
        wire.summary.slice(0, 4000),
        JSON.stringify(wire.comment_coverage.filter((c) => knownIds.has(c.comment_id))),
        JSON.stringify(input),
        JSON.stringify(raw),
      ],
    );
    const id = p!.id;
    await q.query("update edit_proposals set root_id = $1 where id = $1", [id]);
    await recordActivity(q, {
      projectId: ctx.project_id,
      videoId,
      actorType: opts.mode === "claude" ? "ai" : "system",
      actorName: opts.mode === "claude" ? `Claude (${model})` : "Offline draft (no AI)",
      eventType: "proposal.created",
      data: { proposal_id: id, operations: wire.operations.length, requested_by: actor, status: "draft" },
    });

    const seen = new Set<string>();
    let position = 0;
    for (const op of wire.operations) {
      position += 1;
      await insertOperation(q, id, op, position, seen, { adapter, durationMs: ctx.duration_ms, knownCommentIds: knownIds });
    }
    await q.query("update edit_proposals set status = 'validated' where id = $1", [id]);
    await recordActivity(q, {
      projectId: ctx.project_id,
      videoId,
      actorType: "system",
      actorName: "Validator",
      eventType: "proposal.validated",
      data: { proposal_id: id },
    });
    const { status } = await refreshDraftState(q, id);
    await recordActivity(q, {
      projectId: ctx.project_id,
      videoId,
      actorType: "system",
      actorName: "Validator",
      eventType: status === "needs_clarification" ? "proposal.needs_clarification" : "proposal.awaiting_approval",
      data: { proposal_id: id },
    });
    return id;
  });
  log.info("proposal.generated", { proposal_id: proposalId, mode: opts.mode, operations: wire.operations.length });
  return proposalId;
}

async function insertOperation(
  q: Queryable,
  proposalId: string,
  op: WireOperationT,
  position: number,
  seen: Set<string>,
  ctx: { adapter: AdapterId; durationMs: number | null; knownCommentIds: Set<string> },
) {
  let key = (op.operation_id || `op_${position}`).replace(/[^\w.-]/g, "_").slice(0, 60) || `op_${position}`;
  while (seen.has(key)) key = `${key}_${position}`;
  seen.add(key);
  const opType = (OP_TYPES as readonly string[]).includes(op.operation_type) ? op.operation_type : "manual_instruction";
  const startMs = Math.max(0, Math.round(Number(op.start_ms) || 0));
  const endMs = op.end_ms === null || op.end_ms === undefined ? null : Math.round(Number(op.end_ms));
  const input: OpForValidation = {
    op_type: opType,
    start_ms: startMs,
    end_ms: endMs,
    params: op.params ?? {},
    source_comment_ids: op.source_comment_ids ?? [],
    needs_clarification: Boolean(op.needs_clarification),
  };
  const v = validateOperation(input, ctx);
  // keep DB constraints satisfiable even when the op is invalid
  const safeEnd = endMs !== null && endMs < startMs ? null : endMs;
  await q.query(
    `insert into edit_operations (proposal_id, op_key, position, source_comment_ids, start_ms, end_ms, op_type, params,
       explanation, confidence, uncertainty, clarification_question, needs_clarification, validation_status,
       validation_errors, adapter_compat)
     values ($1, $2, $3, $4::jsonb, $5, $6, $7, $8::jsonb, $9, $10, $11, $12, $13, $14, $15::jsonb, $16::jsonb)`,
    [
      proposalId,
      key,
      position,
      JSON.stringify(input.source_comment_ids),
      startMs,
      safeEnd,
      opType,
      JSON.stringify(op.params ?? {}),
      (op.explanation || "(no explanation provided)").slice(0, 4000),
      Math.min(1, Math.max(0, Number(op.confidence) || 0)),
      op.uncertainty?.slice(0, 2000) ?? null,
      op.clarification_question?.slice(0, 1000) ?? null,
      input.needs_clarification,
      endMs !== null && endMs < startMs ? "invalid" : v.status,
      JSON.stringify(endMs !== null && endMs < startMs ? [...v.errors, "end_ms is before start_ms"] : v.errors),
      JSON.stringify(compatibilityFor(opType as OpType)),
    ],
  );
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

const PROPOSAL_SELECT = `select p.id, p.video_id, v.title as video_title, v.project_id, pr.name as project_name, p.source_version_id,
  vv.version_number as source_version_number, p.root_id, p.revision, p.supersedes_id, p.status, p.adapter, p.generator,
  p.model, p.summary, p.comment_coverage, p.content_hash, p.approved_hash, p.approved_at, p.approved_by, p.status_reason,
  p.created_at, p.updated_at,
  (select count(*) from edit_operations o where o.proposal_id = p.id)::int as op_total,
  (select count(*) from edit_operations o where o.proposal_id = p.id and o.decision = 'approved')::int as op_approved,
  (select count(*) from edit_operations o where o.proposal_id = p.id and o.decision = 'rejected')::int as op_rejected
  from edit_proposals p join videos v on v.id = p.video_id join projects pr on pr.id = v.project_id
  join video_versions vv on vv.id = p.source_version_id`;

type ProposalRow = Omit<ProposalDTO, "op_counts" | "operations"> & { op_total: number; op_approved: number; op_rejected: number };

function toProposalDTO(r: ProposalRow): ProposalDTO {
  const { op_total, op_approved, op_rejected, ...rest } = r;
  return {
    ...rest,
    op_counts: { total: op_total, approved: op_approved, rejected: op_rejected, pending: op_total - op_approved - op_rejected },
  };
}

export async function listProposals(filter: { videoId?: string; statuses?: ProposalStatus[]; limit?: number } = {}) {
  const db = await getDb();
  const where: string[] = [];
  const params: unknown[] = [];
  if (filter.videoId) {
    params.push(filter.videoId);
    where.push(`p.video_id = $${params.length}`);
  }
  if (filter.statuses?.length) {
    params.push(JSON.stringify(filter.statuses));
    where.push(`p.status in (select jsonb_array_elements_text($${params.length}::jsonb))`);
  }
  params.push(filter.limit ?? 50);
  const rows = await db.query<ProposalRow>(
    `${PROPOSAL_SELECT} ${where.length ? "where " + where.join(" and ") : ""} order by p.created_at desc limit $${params.length}`,
    params,
  );
  return rows.map(toProposalDTO);
}

export async function getProposal(id: string) {
  const db = await getDb();
  const [row] = await db.query<ProposalRow>(`${PROPOSAL_SELECT} where p.id = $1`, [id]);
  if (!row) throw notFound("Proposal not found");
  const operations = await db.query<OperationDTO>(
    `select id, proposal_id, op_key, position, source_comment_ids, start_ms, end_ms, op_type, params, explanation, confidence,
            uncertainty, clarification_question, needs_clarification, validation_status, validation_errors, adapter_compat,
            decision, decided_at, edited_by_editor, execution_status, execution_note
       from edit_operations where proposal_id = $1 order by position`,
    [id],
  );
  const commentIds = [...new Set(operations.flatMap((o) => o.source_comment_ids))];
  const coverageIds = (row.comment_coverage ?? []).map((c) => c.comment_id);
  const allIds = [...new Set([...commentIds, ...coverageIds])];
  const comments = allIds.length
    ? await db.query<{ id: string; author_name: string; author_type: string; body: string; timestamp_ms: number | null; status: string }>(
        `select id, author_name, author_type, body, timestamp_ms, status from comments
          where id in (select (jsonb_array_elements_text($1::jsonb))::uuid)`,
        [JSON.stringify(allIds)],
      )
    : [];
  const revisions = await db.query<{ id: string; revision: number; status: string; created_at: string }>(
    "select id, revision, status, created_at from edit_proposals where root_id = $1 order by revision",
    [row.root_id ?? id],
  );
  const history = await db.query<{ id: string; actor_type: string; actor_name: string | null; event_type: string; data: Record<string, unknown>; created_at: string }>(
    `select id, actor_type, actor_name, event_type, data, created_at from activity_events
      where data->>'proposal_id' = $1 order by created_at`,
    [id],
  );
  const jobs = await db.query<{ id: string; status: string; created_at: string; attempts: number; result_version_id: string | null }>(
    "select id, status, created_at, attempts, result_version_id from edit_jobs where proposal_id = $1 order by created_at desc",
    [id],
  );
  const currentHash = computeContentHash(row, await loadOps(db, id));
  return {
    proposal: { ...toProposalDTO(row), operations },
    comments,
    revisions,
    history,
    jobs,
    integrity: {
      current_hash: currentHash,
      approval_valid: row.approved_hash ? row.approved_hash === currentHash : null,
    },
  };
}

// ---------------------------------------------------------------------------
// Editing & decisions (pre-approval only)
// ---------------------------------------------------------------------------

async function lockEditable(q: Queryable, proposalId: string) {
  const [p] = await q.query<{
    id: string;
    status: ProposalStatus;
    adapter: AdapterId;
    source_version_id: string;
    video_id: string;
    project_id: string;
    duration_ms: number | null;
  }>(
    `select p.id, p.status, p.adapter, p.source_version_id, p.video_id, v.project_id, vv.duration_ms
       from edit_proposals p join videos v on v.id = p.video_id join video_versions vv on vv.id = p.source_version_id
      where p.id = $1 for update of p`,
    [proposalId],
  );
  if (!p) throw notFound("Proposal not found");
  if (!EDITABLE_STATES.includes(p.status)) {
    throw conflict(
      FROZEN_STATES.includes(p.status)
        ? "This revision is approved and frozen. Create a new revision to make changes."
        : `Proposal is ${p.status} and can no longer be edited.`,
    );
  }
  return p;
}

async function knownCommentIdsFor(q: Queryable, versionId: string) {
  const rows = await q.query<{ id: string }>("select id from comments where video_version_id = $1 and parent_id is null", [versionId]);
  return new Set(rows.map((r) => r.id));
}

export interface OperationEdit {
  op_type?: string;
  start_ms?: number;
  end_ms?: number | null;
  params?: Record<string, unknown>;
  clarified?: boolean;
}

export async function editOperation(proposalId: string, opId: string, edit: OperationEdit, actor: string) {
  const db = await getDb();
  return db.tx(async (q) => {
    const p = await lockEditable(q, proposalId);
    const [op] = await q.query<OpRow & { needs_clarification: boolean }>(
      `select id, op_key, position, op_type, start_ms, end_ms, params, decision, source_comment_ids, validation_status, needs_clarification
         from edit_operations where id = $1 and proposal_id = $2`,
      [opId, proposalId],
    );
    if (!op) throw notFound("Operation not found");
    if (edit.op_type !== undefined && !(OP_TYPES as readonly string[]).includes(edit.op_type)) {
      throw badRequest(`Unknown operation type "${edit.op_type}"`);
    }
    const next = {
      op_type: edit.op_type ?? op.op_type,
      start_ms: edit.start_ms ?? op.start_ms,
      end_ms: edit.end_ms !== undefined ? edit.end_ms : op.end_ms,
      params: edit.params ?? op.params,
      source_comment_ids: op.source_comment_ids,
      needs_clarification: edit.clarified ? false : op.needs_clarification,
    };
    if (next.end_ms !== null && next.end_ms < next.start_ms) throw badRequest("end_ms must be after start_ms");
    const v = validateOperation(next, {
      adapter: p.adapter,
      durationMs: p.duration_ms,
      knownCommentIds: await knownCommentIdsFor(q, p.source_version_id),
    });
    // Any edit resets this operation's decision: the earlier approval no longer applies.
    await q.query(
      `update edit_operations set op_type = $3, start_ms = $4, end_ms = $5, params = $6::jsonb, needs_clarification = $7,
         validation_status = $8, validation_errors = $9::jsonb, adapter_compat = $10::jsonb, decision = 'pending',
         decided_at = null, edited_by_editor = true
       where id = $1 and proposal_id = $2`,
      [
        opId,
        proposalId,
        next.op_type,
        next.start_ms,
        next.end_ms,
        JSON.stringify(next.params),
        next.needs_clarification,
        v.status,
        JSON.stringify(v.errors),
        JSON.stringify(compatibilityFor(next.op_type as OpType)),
      ],
    );
    const state = await refreshDraftState(q, proposalId);
    await recordActivity(q, {
      projectId: p.project_id,
      videoId: p.video_id,
      actorType: "editor",
      actorName: actor,
      eventType: "proposal.operation_edited",
      data: { proposal_id: proposalId, op_key: op.op_key, previous_decision: op.decision, validation: v.status, content_hash: state.hash },
    });
    return { validation: v, ...state };
  });
}

export async function decideOperation(proposalId: string, opId: string, decision: "approved" | "rejected" | "pending", actor: string) {
  const db = await getDb();
  return db.tx(async (q) => {
    const p = await lockEditable(q, proposalId);
    const [op] = await q.query<{ op_key: string; validation_status: string }>(
      "select op_key, validation_status from edit_operations where id = $1 and proposal_id = $2",
      [opId, proposalId],
    );
    if (!op) throw notFound("Operation not found");
    if (decision === "approved" && op.validation_status !== "valid") {
      throw conflict(
        op.validation_status === "needs_clarification"
          ? "This operation needs clarification. Edit it (and mark it clarified) or reject it."
          : op.validation_status === "unsupported"
            ? "The target adapter cannot execute this operation. Change the operation type, switch adapter, or reject it."
            : "This operation is invalid. Fix its parameters or reject it.",
      );
    }
    await q.query(
      "update edit_operations set decision = $3, decided_at = case when $3 = 'pending' then null else now() end where id = $1 and proposal_id = $2",
      [opId, proposalId, decision],
    );
    const state = await refreshDraftState(q, proposalId);
    await recordActivity(q, {
      projectId: p.project_id,
      videoId: p.video_id,
      actorType: "editor",
      actorName: actor,
      eventType: `proposal.operation_${decision === "pending" ? "reset" : decision}`,
      data: { proposal_id: proposalId, op_key: op.op_key },
    });
    return state;
  });
}

export async function changeAdapter(proposalId: string, adapter: string, actor: string) {
  if (!isAdapterId(adapter) || !ADAPTERS[adapter].implemented) throw badRequest(`Adapter "${adapter}" is not available`);
  const db = await getDb();
  return db.tx(async (q) => {
    const p = await lockEditable(q, proposalId);
    if (p.adapter === adapter) return refreshDraftState(q, proposalId);
    await q.query("update edit_proposals set adapter = $2 where id = $1", [proposalId, adapter]);
    const known = await knownCommentIdsFor(q, p.source_version_id);
    const ops = await q.query<OpRow>(
      "select id, op_key, position, op_type, start_ms, end_ms, params, decision, source_comment_ids, validation_status, needs_clarification from edit_operations where proposal_id = $1",
      [proposalId],
    );
    for (const op of ops) {
      const v = validateOperation(op, { adapter, durationMs: p.duration_ms, knownCommentIds: known });
      await q.query(
        `update edit_operations set validation_status = $2, validation_errors = $3::jsonb, decision = 'pending', decided_at = null
          where id = $1`,
        [op.id, v.status, JSON.stringify(v.errors)],
      );
    }
    const state = await refreshDraftState(q, proposalId);
    await recordActivity(q, {
      projectId: p.project_id,
      videoId: p.video_id,
      actorType: "editor",
      actorName: actor,
      eventType: "proposal.adapter_changed",
      data: { proposal_id: proposalId, from: p.adapter, to: adapter, note: "all decisions reset" },
    });
    return state;
  });
}

/**
 * Final approval of an exact revision. The editor must send the content hash
 * they reviewed; if anything changed since, approval is refused.
 */
export async function approveProposal(proposalId: string, expectedHash: string, actor: string) {
  const db = await getDb();
  return db.tx(async (q) => {
    const p = await lockEditable(q, proposalId);
    if (p.status !== "awaiting_approval") {
      throw conflict(
        p.status === "needs_clarification"
          ? "Resolve or reject the operations that need clarification first."
          : `Proposal must be awaiting approval (currently ${p.status}).`,
      );
    }
    const ops = await loadOps(q, proposalId);
    const hash = computeContentHash(p, ops);
    if (hash !== expectedHash) {
      throw conflict("The proposal changed since you loaded it. Review the latest revision and approve again.", { current_hash: hash });
    }
    const pending = ops.filter((o) => o.decision === "pending");
    if (pending.length) throw conflict(`Decide every operation first (${pending.length} still pending).`);
    const approved = ops.filter((o) => o.decision === "approved");
    if (!approved.length) throw conflict("At least one operation must be approved. Reject the proposal instead.");
    const bad = approved.filter((o) => o.validation_status !== "valid");
    if (bad.length) throw conflict(`Approved operations must be valid: ${bad.map((o) => o.op_key).join(", ")}`);
    const [version] = await q.query<{ status: string; video_id: string }>("select status, video_id from video_versions where id = $1", [
      p.source_version_id,
    ]);
    if (!version || version.status !== "ready" || version.video_id !== p.video_id) throw conflict("Source version is no longer available.");

    await q.query(
      `update edit_proposals set status = 'approved', approved_hash = $2, content_hash = $2, approved_at = now(), approved_by = $3
        where id = $1`,
      [proposalId, hash, actor],
    );
    await recordActivity(q, {
      projectId: p.project_id,
      videoId: p.video_id,
      actorType: "editor",
      actorName: actor,
      eventType: "proposal.approved",
      data: {
        proposal_id: proposalId,
        approved_hash: hash,
        source_version_id: p.source_version_id,
        adapter: p.adapter,
        approved_operations: approved.map((o) => o.op_key),
        rejected_operations: ops.filter((o) => o.decision === "rejected").map((o) => o.op_key),
      },
    });
    return { approved_hash: hash };
  });
}

export async function rejectProposal(proposalId: string, reason: string | null, actor: string) {
  const db = await getDb();
  await db.tx(async (q) => {
    const p = await lockEditable(q, proposalId);
    await q.query("update edit_proposals set status = 'rejected', status_reason = $2 where id = $1", [proposalId, reason]);
    await recordActivity(q, {
      projectId: p.project_id,
      videoId: p.video_id,
      actorType: "editor",
      actorName: actor,
      eventType: "proposal.rejected",
      data: { proposal_id: proposalId, reason },
    });
  });
}

/**
 * Creates revision N+1 from any non-running revision. All decisions reset,
 * so the new revision needs a fresh, explicit approval.
 */
export async function createRevision(proposalId: string, actor: string): Promise<string> {
  const db = await getDb();
  return db.tx(async (q) => {
    const [p] = await q.query<{
      id: string;
      status: ProposalStatus;
      root_id: string;
      video_id: string;
      source_version_id: string;
      adapter: AdapterId;
      generator: string;
      model: string | null;
      summary: string | null;
      comment_coverage: unknown;
      input_snapshot: unknown;
      project_id: string;
      duration_ms: number | null;
    }>(
      `select p.id, p.status, coalesce(p.root_id, p.id) as root_id, p.video_id, p.source_version_id, p.adapter, p.generator,
              p.model, p.summary, p.comment_coverage, p.input_snapshot, v.project_id, vv.duration_ms
         from edit_proposals p join videos v on v.id = p.video_id join video_versions vv on vv.id = p.source_version_id
        where p.id = $1 for update of p`,
      [proposalId],
    );
    if (!p) throw notFound("Proposal not found");
    if (p.status === "running") throw conflict("A job is running for this revision. Cancel it before revising.");
    const [latest] = await q.query<{ id: string; revision: number }>(
      "select id, revision from edit_proposals where root_id = $1 order by revision desc limit 1",
      [p.root_id],
    );
    if (latest && latest.id !== proposalId) throw conflict("Only the latest revision can be revised.");

    const [created] = await q.query<{ id: string }>(
      `insert into edit_proposals (video_id, source_version_id, root_id, revision, supersedes_id, status, adapter, generator,
          model, summary, comment_coverage, input_snapshot)
       values ($1, $2, $3, $4, $5, 'draft', $6, $7, $8, $9, $10::jsonb, $11::jsonb) returning id`,
      [
        p.video_id,
        p.source_version_id,
        p.root_id,
        (latest?.revision ?? 1) + 1,
        proposalId,
        p.adapter,
        p.generator,
        p.model,
        p.summary,
        JSON.stringify(p.comment_coverage ?? []),
        JSON.stringify(p.input_snapshot ?? null),
      ],
    );
    const newId = created!.id;
    await q.query(
      `insert into edit_operations (proposal_id, op_key, position, source_comment_ids, start_ms, end_ms, op_type, params, explanation,
          confidence, uncertainty, clarification_question, needs_clarification, validation_status, validation_errors, adapter_compat,
          decision, edited_by_editor)
       select $2, op_key, position, source_comment_ids, start_ms, end_ms, op_type, params, explanation, confidence, uncertainty,
          clarification_question, needs_clarification, validation_status, validation_errors, adapter_compat, 'pending', edited_by_editor
         from edit_operations where proposal_id = $1`,
      [proposalId, newId],
    );
    // revalidate against current state (comments may have changed)
    const known = await knownCommentIdsFor(q, p.source_version_id);
    for (const op of await loadOps(q, newId)) {
      const v = validateOperation(op, { adapter: p.adapter, durationMs: p.duration_ms, knownCommentIds: known });
      await q.query("update edit_operations set validation_status = $2, validation_errors = $3::jsonb where id = $1", [
        op.id,
        v.status,
        JSON.stringify(v.errors),
      ]);
    }
    await refreshDraftState(q, newId);

    if (!["completed", "rejected", "cancelled", "failed"].includes(p.status)) {
      await q.query(
        "update edit_jobs set status = 'cancelled', finished_at = now(), error = 'Superseded by a new proposal revision' where proposal_id = $1 and status = 'queued'",
        [proposalId],
      );
      await q.query("update edit_proposals set status = 'cancelled', status_reason = $2 where id = $1", [
        proposalId,
        `Superseded by revision ${(latest?.revision ?? 1) + 1}`,
      ]);
    }
    await recordActivity(q, {
      projectId: p.project_id,
      videoId: p.video_id,
      actorType: "editor",
      actorName: actor,
      eventType: "proposal.revision_created",
      data: { proposal_id: newId, supersedes_id: proposalId, revision: (latest?.revision ?? 1) + 1 },
    });
    return newId;
  });
}

/** Posts the operation's clarification question as a reply the client can see. */
export async function postClarification(proposalId: string, opId: string, actor: string) {
  const db = await getDb();
  return db.tx(async (q) => {
    const [op] = await q.query<{ clarification_question: string | null; source_comment_ids: string[]; video_id: string; source_version_id: string }>(
      `select o.clarification_question, o.source_comment_ids, p.video_id, p.source_version_id
         from edit_operations o join edit_proposals p on p.id = o.proposal_id where o.id = $1 and o.proposal_id = $2`,
      [opId, proposalId],
    );
    if (!op) throw notFound("Operation not found");
    if (!op.clarification_question) throw badRequest("This operation has no clarification question");
    const parentId = op.source_comment_ids[0];
    if (!parentId) throw badRequest("Operation has no source comment");
    const commentId = await createComment(
      {
        videoId: op.video_id,
        versionId: op.source_version_id,
        parentId,
        authorType: "ai",
        authorName: "AI assistant",
        body: `Question about this note (sent by ${actor}): ${op.clarification_question}`,
      },
      q,
    );
    await recordActivity(q, {
      actorType: "editor",
      actorName: actor,
      videoId: op.video_id,
      eventType: "proposal.clarification_posted",
      data: { proposal_id: proposalId, comment_id: commentId },
    });
    return commentId;
  });
}

// ---------------------------------------------------------------------------
// Pre-execution revalidation (used by the job system)
// ---------------------------------------------------------------------------

export interface ExecutableOperation extends OpRow {
  explanation: string;
}

/**
 * Re-checks everything immediately before a job may run: approval hash,
 * source version, permissions/state, parameters and adapter capability.
 */
export async function revalidateForExecution(
  q: Queryable,
  proposalId: string,
  expected: { approvedHash: string; adapter: string; sourceVersionId: string; deviceAdapters?: string[] },
): Promise<{ ok: true; operations: ExecutableOperation[] } | { ok: false; reason: string }> {
  const [p] = await q.query<{
    status: ProposalStatus;
    approved_hash: string | null;
    adapter: AdapterId;
    source_version_id: string;
    video_id: string;
    video_status: string;
    project_status: string;
    version_status: string;
    version_video_id: string;
    duration_ms: number | null;
  }>(
    `select p.status, p.approved_hash, p.adapter, p.source_version_id, p.video_id, v.status as video_status,
            pr.status as project_status, vv.status as version_status, vv.video_id as version_video_id, vv.duration_ms
       from edit_proposals p join videos v on v.id = p.video_id join projects pr on pr.id = v.project_id
       join video_versions vv on vv.id = p.source_version_id
      where p.id = $1`,
    [proposalId],
  );
  if (!p) return { ok: false, reason: "Proposal no longer exists" };
  if (!["approved", "queued", "running"].includes(p.status)) return { ok: false, reason: `Proposal is ${p.status}` };
  if (!p.approved_hash || p.approved_hash !== expected.approvedHash) return { ok: false, reason: "Approval does not match this job" };
  if (p.adapter !== expected.adapter || p.source_version_id !== expected.sourceVersionId) {
    return { ok: false, reason: "Job adapter/source version differ from the approved revision" };
  }
  if (p.project_status !== "active" || p.video_status !== "active") return { ok: false, reason: "Project or video is archived" };
  if (p.version_status !== "ready" || p.version_video_id !== p.video_id) return { ok: false, reason: "Source version is not available" };
  if (!ADAPTERS[p.adapter]?.implemented) return { ok: false, reason: `Adapter ${p.adapter} is not implemented` };
  if (expected.deviceAdapters && !expected.deviceAdapters.includes(p.adapter)) {
    return { ok: false, reason: `Device does not provide the ${p.adapter} adapter` };
  }
  const ops = await q.query<ExecutableOperation>(
    `select id, op_key, position, op_type, start_ms, end_ms, params, decision, source_comment_ids, validation_status,
            needs_clarification, explanation
       from edit_operations where proposal_id = $1 order by position`,
    [proposalId],
  );
  const hash = computeContentHash({ source_version_id: p.source_version_id, adapter: p.adapter }, ops);
  if (hash !== p.approved_hash) return { ok: false, reason: "Operations changed after approval (hash mismatch)" };
  const approved = ops.filter((o) => o.decision === "approved");
  if (!approved.length) return { ok: false, reason: "No approved operations" };
  for (const op of approved) {
    const shape = validateOperationShape(op, p.duration_ms);
    if (!shape.ok) return { ok: false, reason: `Operation ${op.op_key} failed validation: ${shape.errors.join("; ")}` };
    if (op.needs_clarification) return { ok: false, reason: `Operation ${op.op_key} still needs clarification` };
    if (!adapterSupports(p.adapter, op.op_type as OpType)) return { ok: false, reason: `Adapter cannot execute ${op.op_type}` };
  }
  return { ok: true, operations: approved };
}
