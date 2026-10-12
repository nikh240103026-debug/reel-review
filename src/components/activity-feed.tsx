import Link from "next/link";
import { Bot, Cpu, MessageSquare, Upload, User, Wrench } from "lucide-react";
import { formatTimecode, timeAgo } from "@/lib/format";
import type { ActivityDTO } from "@/shared/dto";

export function describeActivity(e: ActivityDTO): string {
  const d = e.data as Record<string, unknown>;
  switch (e.event_type) {
    case "project.created":
      return `created project “${d.name}”`;
    case "project.renamed":
      return `renamed project to “${d.to}”`;
    case "project.archived":
      return "archived the project";
    case "project.restored":
      return "restored the project";
    case "video.updated":
      return d.to ? `renamed video to “${d.to}”` : "updated a video";
    case "video.archived":
      return "archived a video";
    case "version.upload_started":
      return `started uploading v${d.version_number} (${d.filename})`;
    case "version.upload_failed":
      return `upload of v${d.version_number} failed`;
    case "version.ready":
      return `v${d.version_number} is ready for review`;
    case "review_link.created":
      return `created a ${d.scope} review link${d.can_comment ? "" : " (view only)"}`;
    case "review_link.revoked":
      return "revoked a review link";
    case "comment.created":
      return `commented at ${formatTimecode(d.timestamp_ms as number)}: “${String(d.excerpt ?? "").slice(0, 80)}”`;
    case "comment.replied":
      return `replied: “${String(d.excerpt ?? "").slice(0, 80)}”`;
    case "comment.resolved":
      return "resolved a comment";
    case "comment.reopened":
      return "reopened a comment";
    case "proposal.created":
      return `generated an edit proposal (${d.operations} operation${d.operations === 1 ? "" : "s"})`;
    case "proposal.validated":
      return "validated the proposal";
    case "proposal.awaiting_approval":
      return "marked the proposal ready for approval";
    case "proposal.needs_clarification":
      return "flagged the proposal as needing clarification";
    case "proposal.operation_edited":
      return `edited operation ${d.op_key} (its approval was reset)`;
    case "proposal.operation_approved":
      return `approved operation ${d.op_key}`;
    case "proposal.operation_rejected":
      return `rejected operation ${d.op_key}`;
    case "proposal.operation_reset":
      return `reset the decision on ${d.op_key}`;
    case "proposal.adapter_changed":
      return `switched adapter ${d.from} → ${d.to} (decisions reset)`;
    case "proposal.approved":
      return `approved the proposal revision (${String(d.approved_hash).slice(0, 8)})`;
    case "proposal.rejected":
      return "rejected the proposal";
    case "proposal.revision_created":
      return `created proposal revision ${d.revision}`;
    case "proposal.clarification_posted":
      return "asked the client a clarification question";
    case "job.queued":
      return `queued an editing job (${d.adapter})`;
    case "job.completed":
      return d.render === false ? "completed the editing job (no new render)" : "completed the editing job and published a new version";
    case "job.failed":
      return `editing job failed: ${String(d.error ?? "")}`;
    case "device.registration_created":
      return `created a registration code for “${d.name}”`;
    case "device.registered":
      return "registered as an editing device";
    case "device.revoked":
      return `revoked device “${d.name}”`;
    default:
      return e.event_type.replace(/[._]/g, " ");
  }
}

function ActorIcon({ type }: { type: string }) {
  const cls = "size-3.5";
  if (type === "client") return <User className={`${cls} text-client`} />;
  if (type === "ai") return <Bot className={`${cls} text-ai`} />;
  if (type === "agent") return <Cpu className={`${cls} text-info`} />;
  if (type === "system") return <MessageSquare className={`${cls} text-muted-foreground`} />;
  if (type === "editor") return <Wrench className={`${cls} text-editor`} />;
  return <Upload className={cls} />;
}

export function ActivityFeed({ items, showContext = true }: { items: ActivityDTO[]; showContext?: boolean }) {
  if (!items.length) return <p className="px-4 py-6 text-center text-sm text-muted-foreground">No activity yet.</p>;
  return (
    <ul className="divide-y">
      {items.map((e) => (
        <li key={e.id} className="flex gap-3 px-4 py-2.5">
          <span className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full bg-subtle">
            <ActorIcon type={e.actor_type} />
          </span>
          <div className="min-w-0 flex-1 text-[13px] leading-5">
            <span className="font-medium">{e.actor_name ?? e.actor_type}</span>{" "}
            <span className="text-muted-foreground">{describeActivity(e)}</span>
            {showContext && (e.project_name || e.video_title) && (
              <div className="truncate text-xs text-muted-foreground">
                {e.video_id && e.video_title ? (
                  <Link className="hover:text-foreground" href={`/videos/${e.video_id}`}>
                    {e.project_name} / {e.video_title}
                  </Link>
                ) : e.project_id ? (
                  <Link className="hover:text-foreground" href={`/projects/${e.project_id}`}>
                    {e.project_name}
                  </Link>
                ) : null}
              </div>
            )}
          </div>
          <time className="shrink-0 text-xs text-muted-foreground tabular" dateTime={e.created_at} suppressHydrationWarning>
            {timeAgo(e.created_at)}
          </time>
        </li>
      ))}
    </ul>
  );
}
