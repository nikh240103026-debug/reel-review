import { AlertTriangle, Bot, CheckCircle2, CircleDashed, Clock, Loader2, User, Wrench, XCircle } from "lucide-react";
import { cn } from "@/lib/utils";

type Tone = "neutral" | "info" | "success" | "warning" | "danger" | "ai" | "primary";

const TONES: Record<Tone, string> = {
  neutral: "bg-muted text-muted-foreground ring-white/5",
  info: "bg-info/12 text-info ring-info/20",
  success: "bg-success/12 text-success ring-success/20",
  warning: "bg-warning/12 text-warning ring-warning/20",
  danger: "bg-destructive/12 text-destructive ring-destructive/25",
  ai: "bg-ai/12 text-ai ring-ai/20",
  primary: "bg-primary/15 text-primary ring-primary/25",
};

export function Pill({ tone = "neutral", children, className }: { tone?: Tone; children: React.ReactNode; className?: string }) {
  return (
    <span
      className={cn(
        "inline-flex h-5 shrink-0 items-center gap-1 rounded-full px-2 text-[11px] font-medium whitespace-nowrap ring-1 ring-inset",
        TONES[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}

const STATUS_TONES: Record<string, Tone> = {
  // proposals
  draft: "neutral",
  validated: "info",
  awaiting_approval: "warning",
  approved: "primary",
  queued: "info",
  running: "info",
  completed: "success",
  failed: "danger",
  rejected: "neutral",
  cancelled: "neutral",
  needs_clarification: "warning",
  // versions
  uploading: "info",
  processing: "info",
  ready: "success",
  // links
  active: "success",
  revoked: "danger",
  expired: "neutral",
  pending: "warning",
  // operations
  valid: "success",
  invalid: "danger",
  unsupported: "warning",
  not_started: "neutral",
  done: "success",
  skipped: "neutral",
  manual_pending: "warning",
  manual_done: "success",
  open: "warning",
  resolved: "success",
};

const LABELS: Record<string, string> = {
  awaiting_approval: "Awaiting approval",
  needs_clarification: "Needs clarification",
  not_started: "Not started",
  manual_pending: "Manual task pending",
  manual_done: "Done (manual)",
};

export function statusLabel(s: string) {
  return LABELS[s] ?? s.charAt(0).toUpperCase() + s.slice(1).replace(/_/g, " ");
}

export function StatusBadge({ status, className }: { status: string; className?: string }) {
  const tone = STATUS_TONES[status] ?? "neutral";
  const Icon =
    status === "running" || status === "uploading" || status === "processing"
      ? Loader2
      : status === "completed" || status === "ready" || status === "done" || status === "manual_done" || status === "valid"
        ? CheckCircle2
        : status === "failed" || status === "invalid" || status === "revoked"
          ? XCircle
          : status === "needs_clarification" || status === "unsupported"
            ? AlertTriangle
            : status === "queued" || status === "awaiting_approval" || status === "pending" || status === "manual_pending"
              ? Clock
              : CircleDashed;
  return (
    <Pill tone={tone} className={className}>
      <Icon className={cn("size-3", (status === "running" || status === "uploading" || status === "processing") && "animate-spin")} />
      {statusLabel(status)}
    </Pill>
  );
}

export function AuthorBadge({ type }: { type: string }) {
  if (type === "client")
    return (
      <Pill className="bg-client/10 text-client ring-client/20">
        <User className="size-3" />
        Client
      </Pill>
    );
  if (type === "editor")
    return (
      <Pill className="bg-editor/10 text-editor ring-editor/20">
        <Wrench className="size-3" />
        Editor
      </Pill>
    );
  if (type === "ai")
    return (
      <Pill tone="ai">
        <Bot className="size-3" />
        AI
      </Pill>
    );
  return <Pill>System</Pill>;
}

export function EmptyState({
  icon: Icon,
  title,
  description,
  action,
  className,
}: {
  icon?: React.ComponentType<{ className?: string }>;
  title: string;
  description?: React.ReactNode;
  action?: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-col items-center justify-center rounded-lg border border-dashed px-6 py-10 text-center", className)}>
      {Icon && <Icon className="mb-3 size-6 text-muted-foreground" />}
      <p className="text-sm font-medium">{title}</p>
      {description && <p className="mt-1 max-w-sm text-sm text-muted-foreground">{description}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

export function Section({ title, actions, children, className }: { title: React.ReactNode; actions?: React.ReactNode; children: React.ReactNode; className?: string }) {
  return (
    <section className={cn("rounded-lg border bg-card", className)}>
      <div className="flex min-h-11 items-center justify-between gap-2 border-b px-4 py-2">
        <h2 className="text-[13px] font-medium">{title}</h2>
        {actions}
      </div>
      <div>{children}</div>
    </section>
  );
}
