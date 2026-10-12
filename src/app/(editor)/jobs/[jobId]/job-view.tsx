"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Ban, CheckSquare, Loader2, RotateCcw, Square, Upload } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Progress } from "@/components/ui/progress";
import { PageHeader } from "@/components/app-shell";
import { Pill, Section, StatusBadge } from "@/components/status";
import { FilePickButton, UploadList, useUploads } from "@/components/editor/upload-manager";
import { api, errorText } from "@/lib/client/api";
import { cn } from "@/lib/utils";
import { formatDateTime, formatTimecode, timeAgo } from "@/lib/format";
import { ADAPTERS, OP_LABELS, type AdapterId, type OpType } from "@/shared/operations";
import type { JobDTO, JobLogDTO } from "@/shared/dto";

interface JobData {
  job: JobDTO;
  logs: JobLogDTO[];
  operations: {
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
  }[];
}

export function JobView({ initial, projectId }: { initial: JobData; projectId: string }) {
  const [data, setData] = useState(initial);
  const [busy, setBusy] = useState<string | null>(null);
  const [connError, setConnError] = useState(false);
  const [uploadOpen, setUploadOpen] = useState(false);
  const logRef = useRef<HTMLDivElement>(null);
  const j = data.job;
  const adapter = ADAPTERS[j.adapter as AdapterId];
  const live = j.status === "queued" || j.status === "running";
  const approved = data.operations.filter((o) => o.decision === "approved");
  const allTasksDone = approved.every((o) => o.execution_status === "manual_done");

  const refresh = useCallback(async () => {
    try {
      setData(await api<JobData>(`/api/editor/jobs/${j.id}`));
      setConnError(false);
    } catch {
      setConnError(true);
    }
  }, [j.id]);

  const uploads = useUploads(() => {
    setUploadOpen(false);
    refresh();
  });

  useEffect(() => {
    if (!live) return;
    const t = setInterval(() => document.visibilityState === "visible" && refresh(), 3000);
    return () => clearInterval(t);
  }, [live, refresh]);

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight });
  }, [data.logs.length]);

  async function action(name: string, body: Record<string, unknown>, success?: string) {
    setBusy(name);
    try {
      setData(await api<JobData>(`/api/editor/jobs/${j.id}`, { body }));
      if (success) toast.success(success);
    } catch (err) {
      toast.error(errorText(err));
    } finally {
      setBusy(null);
    }
  }

  return (
    <>
      <PageHeader
        breadcrumb={
          <span>
            <Link href="/jobs" className="hover:text-foreground">
              Jobs
            </Link>{" "}
            /{" "}
            <Link href={`/proposals/${j.proposal_id}`} className="hover:text-foreground">
              Proposal rev {j.proposal_revision}
            </Link>
          </span>
        }
        title={
          <span className="flex flex-wrap items-center gap-2">
            {j.video_title} <StatusBadge status={j.status} />
          </span>
        }
        description={`${adapter?.label ?? j.adapter} · attempt ${j.attempts}/${j.max_attempts} · created ${timeAgo(j.created_at)}`}
        actions={
          <>
            {live && !j.cancel_requested && (
              <Button variant="outline" size="sm" disabled={!!busy} onClick={() => confirm("Cancel this job?") && action("cancel", { action: "cancel" }, "Cancellation requested")}>
                <Ban /> Cancel
              </Button>
            )}
            {(j.status === "failed" || j.status === "cancelled") && (
              <Button size="sm" disabled={!!busy} onClick={() => action("retry", { action: "retry" }, "Job re-queued")}>
                <RotateCcw /> Retry
              </Button>
            )}
            {(j.adapter === "manual" || j.status === "failed") && j.status !== "completed" && j.status !== "cancelled" && (
              <Button size="sm" variant="outline" onClick={() => setUploadOpen(true)}>
                <Upload /> Upload revised video
              </Button>
            )}
          </>
        }
      />

      <div className="grid gap-6 px-4 py-6 sm:px-6 xl:grid-cols-[1fr_420px]">
        <div className="space-y-4">
          {connError && <p className="text-xs text-warning">Disconnected from the server; status may be out of date.</p>}
          {j.status === "running" && (
            <div className="rounded-lg border bg-card px-4 py-3">
              <div className="mb-2 flex items-center justify-between text-xs text-muted-foreground">
                <span>{j.progress_message ?? "Running"}</span>
                <span className="tabular">{Math.round(j.progress * 100)}%</span>
              </div>
              <Progress value={Math.round(j.progress * 100)} className="h-1.5" />
              <div className="mt-2 text-xs text-muted-foreground">
                Device: {j.claimed_by_device_name} · lease until {j.lease_expires_at ? new Date(j.lease_expires_at).toLocaleTimeString() : "—"}
                {j.cancel_requested && <span className="ml-2 text-warning">Cancellation requested…</span>}
              </div>
            </div>
          )}
          {j.status === "queued" && (
            <div className="rounded-lg border bg-card px-4 py-3 text-sm text-muted-foreground">
              <Loader2 className="mr-2 inline size-4 animate-spin" />
              Waiting for {j.target_device_name ? `“${j.target_device_name}”` : "a device"} running the {adapter?.label} adapter to claim this job.
            </div>
          )}
          {j.error && (
            <div className="rounded-lg border border-destructive/30 bg-destructive/8 px-4 py-3 text-sm text-destructive">
              <div className="font-medium">{j.status === "failed" ? "Job failed" : j.status === "cancelled" ? "Job stopped" : "Last attempt failed"}</div>
              <div className="mt-1 break-words">{j.error}</div>
            </div>
          )}
          {j.status === "completed" && (
            <div className="rounded-lg border border-success/30 bg-success/8 px-4 py-3 text-sm text-success">
              {j.result_version_id ? (
                <>
                  Completed. New version v{j.result_version_number} was created from the approved revision.{" "}
                  <Link href={`/videos/${j.video_id}?v=${j.result_version_id}`} className="underline">
                    Review v{j.result_version_number}
                  </Link>
                </>
              ) : (
                "Completed without a new render (manual tasks done)."
              )}
            </div>
          )}

          <Section
            title={j.adapter === "manual" ? "Checklist" : "Approved operations"}
            actions={
              j.adapter === "manual" && j.status === "running" ? (
                <Button
                  size="xs"
                  variant="outline"
                  disabled={!allTasksDone || !!busy}
                  onClick={() => confirm("Complete the job without uploading a new render?") && action("finish", { action: "finish_without_render" }, "Job completed")}
                >
                  Finish without new render
                </Button>
              ) : undefined
            }
          >
            <ul className="divide-y">
              {approved.map((o) => {
                const done = o.execution_status === "manual_done" || o.execution_status === "done";
                const canTick = j.adapter === "manual" && j.status === "running";
                return (
                  <li key={o.id} className="flex gap-3 px-4 py-3">
                    {j.adapter === "manual" ? (
                      <button
                        disabled={!canTick || !!busy}
                        onClick={() => action(`task-${o.id}`, { action: "task", opId: o.id, done: !done })}
                        aria-label={done ? "Mark not done" : "Mark done"}
                        className="mt-0.5 shrink-0 disabled:opacity-50"
                      >
                        {done ? <CheckSquare className="size-4 text-success" /> : <Square className="size-4 text-muted-foreground" />}
                      </button>
                    ) : null}
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className={cn("text-[13px] font-medium", done && j.adapter === "manual" && "line-through opacity-70")}>
                          {OP_LABELS[o.op_type as OpType] ?? o.op_type}
                        </span>
                        <span className="font-mono text-[11px] text-primary">
                          {formatTimecode(o.start_ms)}
                          {o.end_ms !== null && ` → ${formatTimecode(o.end_ms)}`}
                        </span>
                        <StatusBadge status={o.execution_status} />
                      </div>
                      <p className="mt-1 text-xs text-muted-foreground">{o.explanation}</p>
                      <code className="mt-1 block text-[11px] break-all text-muted-foreground">{JSON.stringify(o.params)}</code>
                      {o.execution_note && <p className="mt-1 text-xs">{o.execution_note}</p>}
                    </div>
                  </li>
                );
              })}
            </ul>
          </Section>
        </div>

        <Section title={<span className="flex items-center gap-2">Execution log {live && <Pill tone="info">live</Pill>}</span>} className="h-fit">
          <div ref={logRef} className="max-h-[560px] overflow-y-auto bg-black/30 px-3 py-2 font-mono text-[11px] leading-5">
            {data.logs.length === 0 && <div className="text-muted-foreground">No log entries yet.</div>}
            {data.logs.map((l) => (
              <div key={l.id} className="flex gap-2">
                <span className="shrink-0 text-muted-foreground">{new Date(l.created_at).toLocaleTimeString()}</span>
                <span
                  className={cn(
                    "w-12 shrink-0 uppercase",
                    l.level === "error" ? "text-destructive" : l.level === "warn" ? "text-warning" : l.level === "debug" ? "text-muted-foreground" : "text-info",
                  )}
                >
                  {l.level}
                </span>
                <span className="w-12 shrink-0 text-muted-foreground">{l.source}</span>
                <span className="break-words whitespace-pre-wrap">{l.message}</span>
              </div>
            ))}
          </div>
          <div className="border-t px-3 py-2 text-[11px] text-muted-foreground">
            Started {formatDateTime(j.started_at)} · finished {formatDateTime(j.finished_at)}
          </div>
        </Section>
      </div>

      <Dialog open={uploadOpen} onOpenChange={setUploadOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Upload revised video</DialogTitle>
            <DialogDescription>
              Creates a new version linked to this proposal. The original and earlier versions are preserved.
              {j.adapter === "manual" && j.status === "running" ? " This completes the manual job." : " The job status is not changed by a manual upload."}
            </DialogDescription>
          </DialogHeader>
          <UploadList uploads={uploads} />
          <DialogFooter>
            <FilePickButton
              multiple={false}
              onFiles={([f]) =>
                f &&
                uploads.start(f, {
                  projectId,
                  videoId: j.video_id,
                  source: "manual_revision",
                  jobId: j.id,
                  proposalId: j.proposal_id,
                  notes: `Manual revision for proposal rev ${j.proposal_revision}`,
                })
              }
            >
              <Upload /> Choose file
            </FilePickButton>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
