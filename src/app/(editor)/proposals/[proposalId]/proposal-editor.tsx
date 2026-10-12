"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  AlertTriangle,
  Ban,
  Bot,
  Check,
  CircleHelp,
  GitBranch,
  Loader2,
  Lock,
  MessageSquareQuote,
  Pencil,
  Play,
  RotateCcw,
  ShieldCheck,
  X,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { PageHeader } from "@/components/app-shell";
import { AuthorBadge, Pill, Section, StatusBadge, statusLabel } from "@/components/status";
import { api, errorText } from "@/lib/client/api";
import { formatDateTime, formatTimecode, shortHash, timeAgo } from "@/lib/format";
import { cn } from "@/lib/utils";
import { ADAPTERS, OP_LABELS, OP_TYPES, PARAM_FIELDS, TIME_SHAPE, defaultParams, type AdapterId, type OpType } from "@/shared/operations";
import type { DeviceDTO, OperationDTO, ProposalDTO } from "@/shared/dto";

interface ProposalData {
  proposal: ProposalDTO & { operations: OperationDTO[] };
  comments: { id: string; author_name: string; author_type: string; body: string; timestamp_ms: number | null; status: string }[];
  revisions: { id: string; revision: number; status: string; created_at: string }[];
  history: { id: string; actor_type: string; actor_name: string | null; event_type: string; data: Record<string, unknown>; created_at: string }[];
  jobs: { id: string; status: string; created_at: string; attempts: number; result_version_id: string | null }[];
  integrity: { current_hash: string; approval_valid: boolean | null };
}

const EDITABLE = ["draft", "validated", "awaiting_approval", "needs_clarification"];

export function ProposalEditor({ initial, devices }: { initial: ProposalData; devices: DeviceDTO[] }) {
  const router = useRouter();
  const [data, setData] = useState(initial);
  const [busy, setBusy] = useState<string | null>(null);
  const [approveOpen, setApproveOpen] = useState(false);
  const [queueOpen, setQueueOpen] = useState(false);
  const [rejectOpen, setRejectOpen] = useState(false);
  const p = data.proposal;
  const editable = EDITABLE.includes(p.status);
  const frozen = ["approved", "queued", "running", "completed", "failed"].includes(p.status);
  const ops = p.operations;
  const decided = ops.every((o) => o.decision !== "pending");
  const approvedOps = ops.filter((o) => o.decision === "approved");
  const latestRevision = Math.max(...data.revisions.map((r) => r.revision));
  const isLatest = p.revision === latestRevision;
  const commentById = new Map(data.comments.map((c) => [c.id, c]));

  async function refresh() {
    const fresh = await api<ProposalData>(`/api/editor/proposals/${p.id}`);
    setData(fresh);
  }

  async function act<T>(label: string, fn: () => Promise<T>, success?: string): Promise<T | undefined> {
    setBusy(label);
    try {
      const res = await fn();
      if (success) toast.success(success);
      await refresh();
      return res;
    } catch (err) {
      toast.error(errorText(err));
      await refresh().catch(() => undefined);
      return undefined;
    } finally {
      setBusy(null);
    }
  }

  const supportedDevices = devices.filter((d) => d.adapters.includes(p.adapter));

  return (
    <>
      <PageHeader
        breadcrumb={
          <span className="flex flex-wrap items-center gap-1">
            <Link href={`/projects/${p.project_id}`} className="hover:text-foreground">
              {p.project_name}
            </Link>
            /
            <Link href={`/videos/${p.video_id}?v=${p.source_version_id}`} className="hover:text-foreground">
              {p.video_title}
            </Link>
            / Proposal
          </span>
        }
        title={
          <span className="flex flex-wrap items-center gap-2">
            Edit proposal · revision {p.revision} <StatusBadge status={p.status} />
          </span>
        }
        description={
          <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <span>Source v{p.source_version_number}</span>
            <span className="inline-flex items-center gap-1">
              {p.generator === "claude" ? (
                <>
                  <Bot className="size-3.5 text-ai" /> Claude · {p.model}
                </>
              ) : (
                <Pill tone="warning">Offline draft · not AI</Pill>
              )}
            </span>
            <span>Created {timeAgo(p.created_at)}</span>
          </span>
        }
        actions={
          <>
            {isLatest && p.status !== "running" && (
              <Button
                variant="outline"
                size="sm"
                disabled={!!busy}
                onClick={async () => {
                  const res = await act("revise", () => api<{ proposalId: string }>(`/api/editor/proposals/${p.id}`, { body: { action: "revise" } }), "New revision created");
                  if (res) router.push(`/proposals/${res.proposalId}`);
                }}
              >
                <GitBranch /> New revision
              </Button>
            )}
            {editable && (
              <Button variant="outline" size="sm" onClick={() => setRejectOpen(true)} disabled={!!busy}>
                <Ban /> Reject proposal
              </Button>
            )}
            {p.status === "approved" && (
              <Button size="sm" onClick={() => setQueueOpen(true)} disabled={!!busy}>
                <Play /> Queue editing job
              </Button>
            )}
          </>
        }
      />

      <div className="grid gap-6 px-4 py-6 pb-28 sm:px-6 xl:grid-cols-[1fr_340px]">
        <div className="space-y-4">
          {p.status_reason && (
            <div className="rounded-lg border border-warning/30 bg-warning/8 px-4 py-2.5 text-sm text-warning">{p.status_reason}</div>
          )}
          {!isLatest && (
            <div className="rounded-lg border px-4 py-2.5 text-sm text-muted-foreground">
              This is not the latest revision.{" "}
              <Link className="text-primary hover:underline" href={`/proposals/${data.revisions[data.revisions.length - 1]!.id}`}>
                Open revision {latestRevision}
              </Link>
            </div>
          )}
          {frozen && (
            <div className="flex items-start gap-2 rounded-lg border border-primary/25 bg-primary/8 px-4 py-2.5 text-sm">
              <Lock className="mt-0.5 size-4 shrink-0 text-primary" />
              <div>
                Approved by {p.approved_by} {timeAgo(p.approved_at)} · revision hash <code className="font-mono text-xs">{shortHash(p.approved_hash)}</code>.
                This revision is frozen; any change requires a new revision and a new approval.
                {data.integrity.approval_valid === false && <div className="mt-1 text-destructive">Integrity check failed: content no longer matches the approval.</div>}
              </div>
            </div>
          )}

          {p.summary && (
            <Section title="Summary">
              <p className="px-4 py-3 text-sm leading-6 text-muted-foreground">{p.summary}</p>
            </Section>
          )}

          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-sm font-medium">
              Operations <span className="text-muted-foreground">({ops.length})</span>
            </h2>
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              Adapter
              <select
                value={p.adapter}
                disabled={!editable || !!busy}
                onChange={(e) =>
                  act("adapter", () => api(`/api/editor/proposals/${p.id}`, { body: { action: "set_adapter", adapter: e.target.value } }), "Adapter changed; decisions were reset")
                }
                className="h-7 rounded-md border border-input bg-input/30 px-2 text-xs text-foreground disabled:opacity-60"
              >
                {Object.values(ADAPTERS)
                  .filter((a) => a.implemented)
                  .map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.label}
                    </option>
                  ))}
              </select>
            </div>
          </div>

          {ops.length === 0 && <p className="rounded-lg border border-dashed px-4 py-8 text-center text-sm text-muted-foreground">No operations were proposed.</p>}
          {ops.map((op, i) => (
            <OperationCard
              key={op.id}
              index={i + 1}
              op={op}
              proposal={p}
              editable={editable}
              busy={!!busy}
              comments={op.source_comment_ids.map((id) => commentById.get(id)).filter(Boolean) as ProposalData["comments"]}
              onDecide={(decision) =>
                act(`decide-${op.id}`, () => api(`/api/editor/proposals/${p.id}/operations/${op.id}`, { body: { action: "decide", decision } }))
              }
              onSave={(edit) =>
                act(`edit-${op.id}`, () => api(`/api/editor/proposals/${p.id}/operations/${op.id}`, { method: "PATCH", body: edit }), "Operation updated; its approval was reset")
              }
              onAskClient={() =>
                act(`ask-${op.id}`, () => api(`/api/editor/proposals/${p.id}/operations/${op.id}`, { body: { action: "ask_client" } }), "Question posted as a reply on the comment")
              }
            />
          ))}
        </div>

        <div className="space-y-6">
          <Section title="Comment coverage">
            {p.comment_coverage.length === 0 ? (
              <p className="px-4 py-4 text-sm text-muted-foreground">No coverage reported.</p>
            ) : (
              <ul className="divide-y">
                {p.comment_coverage.map((c) => {
                  const cm = commentById.get(c.comment_id);
                  return (
                    <li key={c.comment_id} className="space-y-1 px-4 py-2.5">
                      <div className="flex items-center gap-2">
                        <StatusBadge status={c.status === "addressed" ? "valid" : c.status === "needs_clarification" ? "needs_clarification" : "skipped"} />
                        {cm && <span className="font-mono text-[11px] text-primary">{formatTimecode(cm.timestamp_ms)}</span>}
                        {cm && <span className="truncate text-xs text-muted-foreground">{cm.author_name}</span>}
                      </div>
                      {cm && <p className="line-clamp-2 text-xs">“{cm.body}”</p>}
                      <p className="text-xs text-muted-foreground">{c.note}</p>
                    </li>
                  );
                })}
              </ul>
            )}
          </Section>

          <Section title="Revisions">
            <ul className="divide-y">
              {data.revisions.map((r) => (
                <li key={r.id}>
                  <Link href={`/proposals/${r.id}`} className={cn("flex items-center justify-between px-4 py-2 text-[13px] hover:bg-subtle", r.id === p.id && "bg-subtle")}>
                    Revision {r.revision}
                    <StatusBadge status={r.status} />
                  </Link>
                </li>
              ))}
            </ul>
          </Section>

          {data.jobs.length > 0 && (
            <Section title="Jobs">
              <ul className="divide-y">
                {data.jobs.map((j) => (
                  <li key={j.id}>
                    <Link href={`/jobs/${j.id}`} className="flex items-center justify-between px-4 py-2 text-[13px] hover:bg-subtle">
                      <span className="text-muted-foreground">{timeAgo(j.created_at)}</span>
                      <StatusBadge status={j.status} />
                    </Link>
                  </li>
                ))}
              </ul>
            </Section>
          )}

          <Section title="Audit history">
            <ol className="space-y-2 px-4 py-3">
              {data.history.map((h) => (
                <li key={h.id} className="text-xs">
                  <span className="text-muted-foreground">{formatDateTime(h.created_at)}</span>
                  <div>
                    <span className="font-medium">{h.actor_name ?? h.actor_type}</span>{" "}
                    <span className="text-muted-foreground">{h.event_type.replace("proposal.", "").replace(/_/g, " ")}</span>
                    {typeof h.data.op_key === "string" && <span className="text-muted-foreground"> · {h.data.op_key}</span>}
                    {typeof h.data.approved_hash === "string" && <code className="ml-1 font-mono text-[10px]">{shortHash(h.data.approved_hash)}</code>}
                  </div>
                </li>
              ))}
            </ol>
          </Section>
        </div>
      </div>

      {/* Approval bar */}
      {editable && (
        <div className="fixed inset-x-0 bottom-0 z-20 border-t bg-panel/95 backdrop-blur md:left-56">
          <div className="flex flex-wrap items-center gap-3 px-4 py-3 sm:px-6">
            <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
              <Pill tone="success">{approvedOps.length} approved</Pill>
              <Pill>{ops.filter((o) => o.decision === "rejected").length} rejected</Pill>
              <Pill tone={decided ? "neutral" : "warning"}>{ops.filter((o) => o.decision === "pending").length} pending</Pill>
              <span className="hidden sm:inline">
                Revision hash <code className="font-mono">{shortHash(p.content_hash)}</code>
              </span>
            </div>
            <div className="ml-auto flex items-center gap-2">
              {p.status === "needs_clarification" && <span className="text-xs text-warning">Resolve or reject operations needing clarification</span>}
              <Button
                disabled={!!busy || !decided || approvedOps.length === 0 || p.status !== "awaiting_approval"}
                onClick={() => setApproveOpen(true)}
              >
                <ShieldCheck /> Approve revision {p.revision}
              </Button>
            </div>
          </div>
        </div>
      )}

      <Dialog open={approveOpen} onOpenChange={setApproveOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Approve revision {p.revision}?</DialogTitle>
            <DialogDescription>
              {approvedOps.length} operation{approvedOps.length === 1 ? "" : "s"} will become executable for the {ADAPTERS[p.adapter as AdapterId]?.label} adapter on source v
              {p.source_version_number}. The approval is bound to this exact content; any later change requires a new revision.
            </DialogDescription>
          </DialogHeader>
          <ul className="max-h-60 space-y-1 overflow-y-auto rounded-lg border p-2 text-xs">
            {approvedOps.map((o) => (
              <li key={o.id} className="flex items-center gap-2">
                <Check className="size-3 text-success" /> {OP_LABELS[o.op_type as OpType] ?? o.op_type} at {formatTimecode(o.start_ms)}
              </li>
            ))}
          </ul>
          <div className="text-xs text-muted-foreground">
            Content hash <code className="font-mono">{p.content_hash}</code>
          </div>
          <DialogFooter>
            <Button
              disabled={!!busy}
              onClick={async () => {
                await act("approve", () => api(`/api/editor/proposals/${p.id}`, { body: { action: "approve", contentHash: p.content_hash } }), "Revision approved");
                setApproveOpen(false);
              }}
            >
              {busy === "approve" ? <Loader2 className="animate-spin" /> : <ShieldCheck />} Approve
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <QueueDialog
        open={queueOpen}
        onOpenChange={setQueueOpen}
        devices={supportedDevices}
        adapter={p.adapter}
        busy={busy === "queue"}
        onQueue={async (deviceId) => {
          const res = await act("queue", () => api<{ jobId: string }>(`/api/editor/proposals/${p.id}`, { body: { action: "queue", deviceId } }), "Job queued");
          if (res) router.push(`/jobs/${res.jobId}`);
        }}
      />

      <RejectDialog
        open={rejectOpen}
        onOpenChange={setRejectOpen}
        onReject={async (reason) => {
          await act("reject", () => api(`/api/editor/proposals/${p.id}`, { body: { action: "reject", reason } }), "Proposal rejected");
          setRejectOpen(false);
        }}
      />
    </>
  );
}

function OperationCard({
  index,
  op,
  proposal,
  editable,
  busy,
  comments,
  onDecide,
  onSave,
  onAskClient,
}: {
  index: number;
  op: OperationDTO;
  proposal: ProposalDTO;
  editable: boolean;
  busy: boolean;
  comments: { id: string; author_name: string; author_type: string; body: string; timestamp_ms: number | null }[];
  onDecide: (d: "approved" | "rejected" | "pending") => void;
  onSave: (edit: Record<string, unknown>) => Promise<unknown>;
  onAskClient: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const canApprove = op.validation_status === "valid";

  return (
    <div
      className={cn(
        "rounded-lg border bg-card",
        op.decision === "approved" && "border-success/35",
        op.decision === "rejected" && "opacity-60",
      )}
    >
      <div className="flex flex-wrap items-center gap-2 border-b px-4 py-2.5">
        <span className="text-xs text-muted-foreground tabular">#{index}</span>
        <span className="text-sm font-medium">{OP_LABELS[op.op_type as OpType] ?? op.op_type}</span>
        <Link
          href={`/videos/${proposal.video_id}?v=${proposal.source_version_id}&t=${op.start_ms}`}
          className="rounded bg-primary/15 px-1.5 py-0.5 font-mono text-[11px] text-primary hover:bg-primary/25"
        >
          {formatTimecode(op.start_ms)}
          {op.end_ms !== null && ` → ${formatTimecode(op.end_ms)}`}
        </Link>
        <StatusBadge status={op.validation_status} />
        {op.edited_by_editor && <Pill tone="info">Edited</Pill>}
        <span className="ml-auto">
          <StatusBadge status={op.decision === "pending" ? "pending" : op.decision} />
        </span>
      </div>

      <div className="space-y-3 px-4 py-3">
        <p className="text-sm leading-6">{op.explanation}</p>

        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          Confidence
          <span className="h-1.5 w-24 overflow-hidden rounded-full bg-white/10">
            <span
              className={cn("block h-full rounded-full", op.confidence >= 0.75 ? "bg-success" : op.confidence >= 0.45 ? "bg-warning" : "bg-destructive")}
              style={{ width: `${Math.round(op.confidence * 100)}%` }}
            />
          </span>
          <span className="tabular">{Math.round(op.confidence * 100)}%</span>
        </div>
        {op.uncertainty && (
          <p className="flex items-start gap-1.5 text-xs text-muted-foreground">
            <CircleHelp className="mt-0.5 size-3.5 shrink-0" /> {op.uncertainty}
          </p>
        )}
        {op.needs_clarification && op.clarification_question && (
          <div className="flex flex-col gap-2 rounded-md border border-warning/30 bg-warning/8 px-3 py-2 text-sm sm:flex-row sm:items-center">
            <span className="flex-1 text-warning">
              <AlertTriangle className="mr-1 inline size-3.5" /> Needs clarification: {op.clarification_question}
            </span>
            {editable && (
              <Button size="xs" variant="outline" onClick={onAskClient} disabled={busy}>
                <MessageSquareQuote /> Ask the client
              </Button>
            )}
          </div>
        )}
        {op.validation_errors.length > 0 && (
          <ul className="space-y-0.5 rounded-md border border-destructive/25 bg-destructive/8 px-3 py-2 text-xs text-destructive">
            {op.validation_errors.map((e, i) => (
              <li key={i}>{e}</li>
            ))}
          </ul>
        )}

        {comments.length > 0 && (
          <div className="space-y-1.5">
            {comments.map((c) => (
              <div key={c.id} className="rounded-md bg-subtle px-3 py-2 text-xs">
                <div className="mb-0.5 flex items-center gap-2">
                  <span className="font-medium">{c.author_name}</span>
                  <AuthorBadge type={c.author_type} />
                  <span className="font-mono text-primary">{formatTimecode(c.timestamp_ms)}</span>
                </div>
                <p className="text-muted-foreground">“{c.body}”</p>
              </div>
            ))}
          </div>
        )}

        {editing ? (
          <OperationEditor op={op} onCancel={() => setEditing(false)} onSave={async (edit) => {
            await onSave(edit);
            setEditing(false);
          }} />
        ) : (
          <div className="rounded-md border">
            <div className="flex items-center justify-between border-b px-3 py-1.5 text-[11px] text-muted-foreground">
              Parameters
              <span className="flex gap-1">
                {Object.entries(op.adapter_compat)
                  .filter(([a]) => ADAPTERS[a as AdapterId]?.implemented)
                  .map(([a, ok]) => (
                    <Pill key={a} tone={ok ? "success" : "neutral"}>
                      {ok ? <Check className="size-3" /> : <X className="size-3" />} {ADAPTERS[a as AdapterId]?.label ?? a}
                    </Pill>
                  ))}
              </span>
            </div>
            <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 px-3 py-2 text-xs">
              {Object.entries(op.params).length === 0 && <dd className="col-span-2 text-muted-foreground">No parameters</dd>}
              {Object.entries(op.params).map(([k, v]) => (
                <div key={k} className="contents">
                  <dt className="text-muted-foreground">{k}</dt>
                  <dd className="font-mono break-all">{typeof v === "string" ? v : JSON.stringify(v)}</dd>
                </div>
              ))}
            </dl>
          </div>
        )}
      </div>

      {editable && !editing && (
        <div className="flex flex-wrap items-center gap-2 border-t px-4 py-2.5">
          <Button size="sm" variant="ghost" onClick={() => setEditing(true)} disabled={busy}>
            <Pencil /> Edit
          </Button>
          <div className="ml-auto flex items-center gap-2">
            {op.decision !== "pending" && (
              <Button size="sm" variant="ghost" onClick={() => onDecide("pending")} disabled={busy}>
                <RotateCcw /> Reset
              </Button>
            )}
            <Button size="sm" variant={op.decision === "rejected" ? "secondary" : "outline"} onClick={() => onDecide("rejected")} disabled={busy || op.decision === "rejected"}>
              <X /> Reject
            </Button>
            <Button
              size="sm"
              variant={op.decision === "approved" ? "secondary" : "default"}
              onClick={() => onDecide("approved")}
              disabled={busy || !canApprove || op.decision === "approved"}
              title={!canApprove ? `Cannot approve: ${statusLabel(op.validation_status)}` : undefined}
            >
              <Check /> Approve
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

function OperationEditor({ op, onSave, onCancel }: { op: OperationDTO; onSave: (e: Record<string, unknown>) => Promise<void>; onCancel: () => void }) {
  const [type, setType] = useState<OpType>(op.op_type as OpType);
  const [params, setParams] = useState<Record<string, unknown>>(op.params);
  const [start, setStart] = useState((op.start_ms / 1000).toFixed(3));
  const [end, setEnd] = useState(op.end_ms === null ? "" : (op.end_ms / 1000).toFixed(3));
  const [clarified, setClarified] = useState(false);
  const [saving, setSaving] = useState(false);
  const shape = TIME_SHAPE[type];

  return (
    <form
      className="space-y-3 rounded-md border border-primary/30 p-3"
      onSubmit={async (e) => {
        e.preventDefault();
        setSaving(true);
        const startMs = Math.round(Number(start) * 1000);
        const endMs = end.trim() === "" ? null : Math.round(Number(end) * 1000);
        await onSave({ op_type: type, start_ms: startMs, end_ms: endMs, params, ...(op.needs_clarification ? { clarified } : {}) });
        setSaving(false);
      }}
    >
      <div className="grid gap-3 sm:grid-cols-3">
        <div className="grid gap-1.5">
          <Label className="text-xs">Operation</Label>
          <select
            value={type}
            onChange={(e) => {
              const t = e.target.value as OpType;
              setType(t);
              setParams(defaultParams(t));
              if (TIME_SHAPE[t] === "point") setEnd("");
            }}
            className="h-8 rounded-lg border border-input bg-input/30 px-2 text-sm"
          >
            {OP_TYPES.map((t) => (
              <option key={t} value={t}>
                {OP_LABELS[t]}
              </option>
            ))}
          </select>
        </div>
        <div className="grid gap-1.5">
          <Label className="text-xs">Start (seconds)</Label>
          <Input type="number" step="0.001" min={0} value={start} onChange={(e) => setStart(e.target.value)} />
        </div>
        <div className="grid gap-1.5">
          <Label className="text-xs">End (seconds){shape === "range" ? "" : " · optional"}</Label>
          <Input type="number" step="0.001" min={0} value={end} disabled={shape === "point"} onChange={(e) => setEnd(e.target.value)} placeholder={shape === "point" ? "n/a" : ""} />
        </div>
      </div>
      {PARAM_FIELDS[type].map((f) => (
        <div key={f.key} className="grid gap-1.5">
          <Label className="text-xs">
            {f.label}
            {f.kind === "number" && f.unit ? <span className="text-muted-foreground"> ({f.unit}, {f.min} to {f.max})</span> : null}
          </Label>
          {f.kind === "number" ? (
            <Input
              type="number"
              step={f.step}
              min={f.min}
              max={f.max}
              value={String(params[f.key] ?? "")}
              onChange={(e) => setParams({ ...params, [f.key]: e.target.value === "" ? "" : Number(e.target.value) })}
            />
          ) : f.kind === "enum" ? (
            <select
              value={String(params[f.key] ?? "")}
              onChange={(e) => setParams({ ...params, [f.key]: e.target.value })}
              className="h-8 rounded-lg border border-input bg-input/30 px-2 text-sm"
            >
              {f.options.map((o) => (
                <option key={o} value={o}>
                  {o.replace(/_/g, " ")}
                </option>
              ))}
            </select>
          ) : f.kind === "color" ? (
            <div className="flex items-center gap-2">
              <input type="color" value={String(params[f.key] ?? "#FFFFFF")} onChange={(e) => setParams({ ...params, [f.key]: e.target.value.toUpperCase() })} className="h-8 w-12 rounded border bg-transparent" />
              <code className="text-xs">{String(params[f.key] ?? "")}</code>
            </div>
          ) : f.kind === "textarea" ? (
            <Textarea rows={2} value={String(params[f.key] ?? "")} onChange={(e) => setParams({ ...params, [f.key]: e.target.value })} />
          ) : (
            <Input value={String(params[f.key] ?? "")} onChange={(e) => setParams({ ...params, [f.key]: e.target.value })} />
          )}
        </div>
      ))}
      {op.needs_clarification && (
        <label className="flex items-center gap-2 text-xs">
          <input type="checkbox" checked={clarified} onChange={(e) => setClarified(e.target.checked)} className="accent-primary" />
          I have resolved the ambiguity (mark as clarified)
        </label>
      )}
      <p className="text-[11px] text-muted-foreground">Saving re-validates this operation and resets its approval decision.</p>
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" size="sm" disabled={saving}>
          {saving && <Loader2 className="animate-spin" />} Save changes
        </Button>
      </div>
    </form>
  );
}

function QueueDialog({
  open,
  onOpenChange,
  devices,
  adapter,
  busy,
  onQueue,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  devices: DeviceDTO[];
  adapter: string;
  busy: boolean;
  onQueue: (deviceId: string | null) => void;
}) {
  const [deviceId, setDeviceId] = useState<string>("");
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Queue editing job</DialogTitle>
          <DialogDescription>
            The local agent picks up the job, re-validates the approval, source version and its own capabilities, then executes only the approved operations.
          </DialogDescription>
        </DialogHeader>
        {devices.length === 0 ? (
          <div className="rounded-lg border border-warning/30 bg-warning/8 px-3 py-2 text-sm text-warning">
            No registered device provides the {ADAPTERS[adapter as AdapterId]?.label} adapter. The job will wait in the queue until one connects. Register a device in Settings.
          </div>
        ) : (
          <div className="grid gap-2">
            <Label>Run on</Label>
            <select value={deviceId} onChange={(e) => setDeviceId(e.target.value)} className="h-8 rounded-lg border border-input bg-input/30 px-2 text-sm">
              <option value="">Any capable device</option>
              {devices.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name} {d.online ? "(online)" : "(offline)"}
                </option>
              ))}
            </select>
          </div>
        )}
        <DialogFooter>
          <Button onClick={() => onQueue(deviceId || null)} disabled={busy}>
            {busy ? <Loader2 className="animate-spin" /> : <Play />} Queue job
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function RejectDialog({ open, onOpenChange, onReject }: { open: boolean; onOpenChange: (o: boolean) => void; onReject: (reason: string | null) => Promise<void> }) {
  const [reason, setReason] = useState("");
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Reject this proposal?</DialogTitle>
          <DialogDescription>Nothing will be executed. You can run AI Review again later.</DialogDescription>
        </DialogHeader>
        <Textarea rows={3} maxLength={1000} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Reason (optional)" />
        <DialogFooter>
          <Button variant="destructive" onClick={() => onReject(reason.trim() || null)}>
            Reject proposal
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
