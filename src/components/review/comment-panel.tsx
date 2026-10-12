"use client";

import { useEffect, useRef, useState } from "react";
import { CheckCircle2, CornerDownRight, Loader2, MessageSquare, PenLine, RotateCcw, Send, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { AuthorBadge, EmptyState } from "@/components/status";
import { cn } from "@/lib/utils";
import { formatTimecode, initials, timeAgo } from "@/lib/format";
import { ANNOTATION_COLORS } from "./annotation-layer";
import type { CommentDTO } from "@/shared/dto";

type Filter = "open" | "resolved" | "all";

export interface ComposerState {
  drawing: boolean;
  strokeCount: number;
  color: string;
}

export function CommentPanel({
  comments,
  loading,
  error,
  selectedId,
  onSelect,
  currentTimeMs,
  canComment,
  canResolve,
  composer,
  onToggleDrawing,
  onClearDrawing,
  onColor,
  onComposerFocus,
  onSubmit,
  onReply,
  onSetStatus,
  identityLabel,
}: {
  comments: CommentDTO[];
  loading: boolean;
  error: string | null;
  selectedId: string | null;
  onSelect: (c: CommentDTO) => void;
  currentTimeMs: number;
  canComment: boolean;
  canResolve: boolean;
  composer: ComposerState;
  onToggleDrawing: () => void;
  onClearDrawing: () => void;
  onColor: (c: string) => void;
  onComposerFocus: () => void;
  onSubmit: (body: string) => Promise<boolean>;
  onReply: (parentId: string, body: string) => Promise<boolean>;
  onSetStatus: (id: string, status: "open" | "resolved") => Promise<void>;
  identityLabel: React.ReactNode;
}) {
  const [filter, setFilter] = useState<Filter>("open");
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);

  const counts = {
    open: comments.filter((c) => c.status === "open").length,
    resolved: comments.filter((c) => c.status === "resolved").length,
    all: comments.length,
  };
  const visible = comments.filter((c) => filter === "all" || c.status === filter);

  useEffect(() => {
    if (!selectedId) return;
    const el = listRef.current?.querySelector(`[data-comment="${selectedId}"]`);
    el?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [selectedId]);

  async function submit(e?: React.FormEvent) {
    e?.preventDefault();
    if (!body.trim() || busy) return;
    setBusy(true);
    const ok = await onSubmit(body.trim());
    setBusy(false);
    if (ok) {
      setBody("");
      setFilter((f) => (f === "resolved" ? "open" : f));
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-1 border-b px-3 py-2">
        {(["open", "resolved", "all"] as Filter[]).map((f) => (
          <button
            key={f}
            onClick={() => setFilter(f)}
            className={cn(
              "h-7 rounded-md px-2.5 text-xs text-muted-foreground capitalize hover:text-foreground",
              filter === f && "bg-accent text-foreground",
            )}
          >
            {f} <span className="ml-0.5 tabular text-muted-foreground">{counts[f]}</span>
          </button>
        ))}
      </div>

      <div ref={listRef} className="min-h-0 flex-1 overflow-y-auto">
        {loading && !comments.length ? (
          <div className="space-y-3 p-3">
            {[0, 1, 2].map((i) => (
              <div key={i} className="h-16 animate-pulse rounded-lg bg-subtle" />
            ))}
          </div>
        ) : error ? (
          <p className="p-4 text-sm text-destructive">{error}</p>
        ) : visible.length === 0 ? (
          <EmptyState
            className="m-3 border-0"
            icon={MessageSquare}
            title={filter === "resolved" ? "No resolved comments" : comments.length ? "Nothing open" : "No comments yet"}
            description={canComment && filter !== "resolved" ? "Pause anywhere and leave a note. It’s pinned to that exact moment." : undefined}
          />
        ) : (
          <ul className="space-y-1 p-2">
            {visible.map((c, i) => (
              <CommentItem
                key={c.id}
                index={comments.indexOf(c) + 1}
                comment={c}
                selected={c.id === selectedId}
                onSelect={() => onSelect(c)}
                canComment={canComment}
                canResolve={canResolve}
                onReply={onReply}
                onSetStatus={onSetStatus}
                last={i === visible.length - 1}
              />
            ))}
          </ul>
        )}
      </div>

      {canComment ? (
        <form onSubmit={submit} className="border-t bg-panel p-3">
          <div className="mb-2 flex items-center justify-between gap-2 text-xs text-muted-foreground">
            <span className="inline-flex items-center gap-1.5">
              <span className="rounded bg-primary/15 px-1.5 py-0.5 font-mono text-primary tabular">{formatTimecode(currentTimeMs)}</span>
              {identityLabel}
            </span>
            <div className="flex items-center gap-1">
              {composer.drawing && (
                <>
                  {ANNOTATION_COLORS.map((c) => (
                    <button
                      type="button"
                      key={c}
                      aria-label={`Colour ${c}`}
                      onClick={() => onColor(c)}
                      className={cn("size-4 rounded-full ring-1 ring-white/20", composer.color === c && "ring-2 ring-white")}
                      style={{ background: c }}
                    />
                  ))}
                  {composer.strokeCount > 0 && (
                    <button type="button" onClick={onClearDrawing} className="rounded p-1 hover:bg-accent" aria-label="Clear drawing">
                      <Trash2 className="size-3.5" />
                    </button>
                  )}
                </>
              )}
              <Button
                type="button"
                size="xs"
                variant={composer.drawing ? "secondary" : "ghost"}
                onClick={onToggleDrawing}
                aria-pressed={composer.drawing}
              >
                <PenLine /> {composer.drawing ? `Drawing${composer.strokeCount ? ` (${composer.strokeCount})` : ""}` : "Draw"}
              </Button>
            </div>
          </div>
          <Textarea
            value={body}
            onChange={(e) => setBody(e.target.value)}
            onFocus={onComposerFocus}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) submit();
            }}
            maxLength={5000}
            rows={3}
            placeholder={`Leave feedback at ${formatTimecode(currentTimeMs)}…`}
            className="resize-none text-sm"
            aria-label="Comment"
          />
          <div className="mt-2 flex items-center justify-between">
            <span className="text-[11px] text-muted-foreground">Ctrl/⌘ + Enter to send</span>
            <Button type="submit" size="sm" disabled={!body.trim() || busy}>
              {busy ? <Loader2 className="animate-spin" /> : <Send />} Comment
            </Button>
          </div>
        </form>
      ) : (
        <div className="border-t px-4 py-3 text-xs text-muted-foreground">This link is view-only. Commenting is disabled.</div>
      )}
    </div>
  );
}

function CommentItem({
  comment: c,
  index,
  selected,
  onSelect,
  canComment,
  canResolve,
  onReply,
  onSetStatus,
}: {
  comment: CommentDTO;
  index: number;
  selected: boolean;
  onSelect: () => void;
  canComment: boolean;
  canResolve: boolean;
  onReply: (parentId: string, body: string) => Promise<boolean>;
  onSetStatus: (id: string, status: "open" | "resolved") => Promise<void>;
  last: boolean;
}) {
  const [replying, setReplying] = useState(false);
  const [reply, setReply] = useState("");
  const [busy, setBusy] = useState(false);
  const hasDrawing = c.attachments.some((a) => a.kind === "annotation");

  return (
    <li
      data-comment={c.id}
      className={cn(
        "rounded-lg border border-transparent px-3 py-2.5 transition-colors",
        selected ? "border-primary/50 bg-primary/8" : "hover:bg-subtle",
        c.status === "resolved" && !selected && "opacity-60",
      )}
    >
      <div role="button" tabIndex={0} onClick={onSelect} onKeyDown={(e) => e.key === "Enter" && onSelect()} className="cursor-pointer">
        <div className="flex items-center gap-2">
          <Avatar name={c.author_name} type={c.author_type} />
          <span className="truncate text-[13px] font-medium">{c.author_name}</span>
          <AuthorBadge type={c.author_type} />
          {c.is_mine && <span className="text-[10px] text-muted-foreground">(you)</span>}
          <span className="ml-auto shrink-0 text-[11px] text-muted-foreground" suppressHydrationWarning>
            {timeAgo(c.created_at)}
          </span>
        </div>
        <div className="mt-1.5 flex items-start gap-2">
          <span className="mt-px shrink-0 rounded bg-primary/15 px-1.5 py-0.5 font-mono text-[11px] text-primary tabular">
            #{index} {formatTimecode(c.timestamp_ms)}
          </span>
          {hasDrawing && <PenLine className="mt-1 size-3 shrink-0 text-muted-foreground" aria-label="Has drawing" />}
        </div>
        <p className="mt-1.5 text-[13px] leading-5 break-words whitespace-pre-wrap">{c.body}</p>
      </div>

      {c.replies.length > 0 && (
        <ul className="mt-2 space-y-2 border-l border-white/10 pl-3">
          {c.replies.map((r) => (
            <li key={r.id}>
              <div className="flex items-center gap-2">
                <Avatar name={r.author_name} type={r.author_type} small />
                <span className="truncate text-xs font-medium">{r.author_name}</span>
                <AuthorBadge type={r.author_type} />
                <span className="ml-auto text-[11px] text-muted-foreground" suppressHydrationWarning>
                  {timeAgo(r.created_at)}
                </span>
              </div>
              <p className="mt-1 text-[13px] leading-5 break-words whitespace-pre-wrap">{r.body}</p>
            </li>
          ))}
        </ul>
      )}

      <div className="mt-2 flex items-center gap-1">
        {canComment && (
          <Button size="xs" variant="ghost" onClick={() => setReplying((r) => !r)}>
            <CornerDownRight /> Reply
          </Button>
        )}
        {canResolve && (
          <Button
            size="xs"
            variant="ghost"
            onClick={async () => {
              setBusy(true);
              await onSetStatus(c.id, c.status === "open" ? "resolved" : "open");
              setBusy(false);
            }}
            disabled={busy}
          >
            {c.status === "open" ? <CheckCircle2 /> : <RotateCcw />}
            {c.status === "open" ? "Resolve" : "Reopen"}
          </Button>
        )}
        {c.status === "resolved" && c.resolved_by_name && (
          <span className="ml-auto text-[11px] text-muted-foreground">Resolved by {c.resolved_by_name}</span>
        )}
      </div>

      {replying && (
        <form
          className="mt-2 flex gap-2"
          onSubmit={async (e) => {
            e.preventDefault();
            if (!reply.trim()) return;
            setBusy(true);
            const ok = await onReply(c.id, reply.trim());
            setBusy(false);
            if (ok) {
              setReply("");
              setReplying(false);
            }
          }}
        >
          <Textarea
            autoFocus
            rows={2}
            maxLength={5000}
            value={reply}
            onChange={(e) => setReply(e.target.value)}
            placeholder="Write a reply…"
            className="min-h-0 resize-none text-sm"
            aria-label="Reply"
          />
          <Button type="submit" size="icon-sm" disabled={!reply.trim() || busy} aria-label="Send reply">
            {busy ? <Loader2 className="animate-spin" /> : <Send />}
          </Button>
        </form>
      )}
    </li>
  );
}

function Avatar({ name, type, small }: { name: string; type: string; small?: boolean }) {
  return (
    <span
      className={cn(
        "flex shrink-0 items-center justify-center rounded-full text-[10px] font-semibold text-black",
        small ? "size-5" : "size-6",
        type === "client" ? "bg-client" : type === "editor" ? "bg-editor" : type === "ai" ? "bg-ai" : "bg-muted-foreground",
      )}
      aria-hidden
    >
      {initials(name)}
    </span>
  );
}
