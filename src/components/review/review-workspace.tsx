"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { AlertTriangle, ChevronLeft, Pencil } from "lucide-react";
import { toast } from "sonner";
import { Pill } from "@/components/status";
import { api, ApiError, errorText } from "@/lib/client/api";
import { getGuestKey, getGuestName, setGuestName } from "@/lib/client/guest";
import { formatTimecode } from "@/lib/format";
import { ReviewPlayer, type Marker, type PlayerHandle } from "./review-player";
import { CommentPanel } from "./comment-panel";
import { GuestNameDialog } from "./guest-name-dialog";
import { ANNOTATION_COLORS } from "./annotation-layer";
import type { AnnotationStroke, CommentDTO, VideoVersionDTO } from "@/shared/dto";

export interface ReviewView {
  video: { id: string; title: string; project_id: string; project_name: string; current_version_id: string | null };
  versions: VideoVersionDTO[];
  permissions: { can_comment: boolean; can_resolve: boolean; is_editor: boolean };
}

export interface WorkspaceContext {
  view: ReviewView;
  version: VideoVersionDTO | null;
  comments: CommentDTO[];
  reload: () => Promise<void>;
  currentTimeMs: number;
}

/**
 * The review screen shared by guests (review link) and editors.
 * Guests: `apiBase` = /api/review/{token}/videos/{id}; editors: /api/editor/videos/{id}.
 */
export function ReviewWorkspace({
  mode,
  apiBase,
  identityBase,
  backHref,
  backLabel,
  toolbar,
  sidebarTabs,
}: {
  mode: "guest" | "editor";
  apiBase: string;
  identityBase?: string;
  backHref?: string;
  backLabel?: string;
  toolbar?: (ctx: WorkspaceContext) => React.ReactNode;
  sidebarTabs?: { id: string; label: string; render: (ctx: WorkspaceContext) => React.ReactNode }[];
}) {
  const router = useRouter();
  const pathname = usePathname();
  const search = useSearchParams();
  const playerRef = useRef<PlayerHandle>(null);

  const [view, setView] = useState<ReviewView | null>(null);
  const [viewError, setViewError] = useState<{ status: number; message: string } | null>(null);
  const [versionId, setVersionId] = useState<string | null>(search.get("v"));
  const [comments, setComments] = useState<CommentDTO[]>([]);
  const [commentsLoading, setCommentsLoading] = useState(true);
  const [commentsError, setCommentsError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [timeMs, setTimeMs] = useState(0);
  const [drawing, setDrawing] = useState(false);
  const [strokes, setStrokes] = useState<AnnotationStroke[]>([]);
  const [color, setColor] = useState(ANNOTATION_COLORS[0]!);
  const [displayStrokes, setDisplayStrokes] = useState<AnnotationStroke[]>([]);
  const [guestName, setGuestNameState] = useState<string | null>(null);
  const [nameDialog, setNameDialog] = useState<"closed" | "required" | "change">("closed");
  const [tab, setTab] = useState("comments");
  const pendingSeek = useRef<number | null>(search.get("t") ? Number(search.get("t")) : null);

  const headers = useMemo(() => (mode === "guest" ? { "x-guest-key": typeof window !== "undefined" ? getGuestKey() : "" } : undefined), [mode]);

  // Guest identity: ask for a name once; remember it in this browser.
  useEffect(() => {
    if (mode !== "guest") return;
    const n = getGuestName();
    setGuestNameState(n);
    if (!n) setNameDialog("required");
  }, [mode]);

  const loadView = useCallback(async () => {
    try {
      const v = await api<ReviewView>(apiBase, { headers });
      setView(v);
      setViewError(null);
      setVersionId((cur) => (cur && v.versions.some((x) => x.id === cur) ? cur : (v.video.current_version_id ?? v.versions.find((x) => x.status === "ready")?.id ?? v.versions[0]?.id ?? null)));
    } catch (err) {
      setViewError({ status: err instanceof ApiError ? err.status : 0, message: errorText(err) });
    }
  }, [apiBase, headers]);

  useEffect(() => {
    loadView();
    // Signed media URLs expire; refresh the view well before that.
    const t = setInterval(loadView, 40 * 60 * 1000);
    return () => clearInterval(t);
  }, [loadView]);

  const loadComments = useCallback(
    async (quiet = false) => {
      if (!versionId) return;
      if (!quiet) setCommentsLoading(true);
      try {
        const { comments } = await api<{ comments: CommentDTO[] }>(`${apiBase}/comments?versionId=${versionId}`, { headers });
        setComments(comments);
        setCommentsError(null);
      } catch (err) {
        if (!quiet) setCommentsError(errorText(err));
        if (err instanceof ApiError && (err.status === 410 || err.status === 404)) setViewError({ status: err.status, message: err.message });
      } finally {
        setCommentsLoading(false);
      }
    },
    [apiBase, versionId, headers],
  );

  useEffect(() => {
    setComments([]);
    setSelectedId(null);
    loadComments();
    const t = setInterval(() => {
      if (document.visibilityState === "visible") loadComments(true);
    }, 10_000);
    return () => clearInterval(t);
  }, [loadComments]);

  const version = view?.versions.find((v) => v.id === versionId) ?? null;

  // Keep ?v= in the URL so links are shareable and reloads keep the version.
  useEffect(() => {
    if (!versionId) return;
    const params = new URLSearchParams(search.toString());
    if (params.get("v") === versionId) return;
    params.set("v", versionId);
    params.delete("t");
    router.replace(`${pathname}?${params.toString()}`, { scroll: false });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [versionId]);

  // Apply a pending ?t= seek once media is ready.
  useEffect(() => {
    if (pendingSeek.current === null || !version?.playback_url) return;
    const ms = pendingSeek.current;
    const t = setTimeout(() => {
      playerRef.current?.seek(ms);
      pendingSeek.current = null;
    }, 300);
    return () => clearTimeout(t);
  }, [version?.playback_url]);

  const markers: Marker[] = useMemo(
    () =>
      comments
        .filter((c) => c.timestamp_ms !== null)
        .map((c, i) => ({
          id: c.id,
          timeMs: c.timestamp_ms!,
          tone: c.author_type === "client" ? "client" : c.author_type === "editor" ? "editor" : "ai",
          resolved: c.status === "resolved",
          label: `#${i + 1} ${c.author_name}: ${c.body.slice(0, 60)}`,
        })),
    [comments],
  );

  const selectComment = useCallback(
    (c: CommentDTO) => {
      setSelectedId(c.id);
      if (c.timestamp_ms !== null) {
        playerRef.current?.pause();
        playerRef.current?.seek(c.timestamp_ms);
      }
      const ann = c.attachments.find((a) => a.kind === "annotation")?.data?.strokes ?? [];
      setDisplayStrokes(ann);
    },
    [],
  );

  const authorHeaders = headers;

  async function postComment(payload: Record<string, unknown>): Promise<boolean> {
    if (!version) return false;
    if (mode === "guest" && !guestName) {
      setNameDialog("required");
      return false;
    }
    try {
      await api(`${apiBase}/comments`, {
        body: { versionId: version.id, ...payload, ...(mode === "guest" ? { authorName: guestName } : {}) },
        headers: authorHeaders,
      });
      await loadComments(true);
      return true;
    } catch (err) {
      toast.error(errorText(err));
      return false;
    }
  }

  const submitComment = async (body: string) => {
    const ts = playerRef.current?.getTimeMs() ?? timeMs;
    const ok = await postComment({ body, timestampMs: Math.max(0, Math.round(ts)), annotation: strokes.length ? { strokes } : null });
    if (ok) {
      setStrokes([]);
      setDrawing(false);
    }
    return ok;
  };

  const reply = (parentId: string, body: string) => postComment({ body, parentId });

  const setStatus = async (id: string, status: "open" | "resolved") => {
    if (mode === "guest" && !guestName) {
      setNameDialog("required");
      return;
    }
    try {
      await api(`${apiBase}/comments/${id}`, { method: "PATCH", body: { status, ...(mode === "guest" ? { actorName: guestName } : {}) }, headers: authorHeaders });
      await loadComments(true);
    } catch (err) {
      toast.error(errorText(err));
    }
  };

  async function saveName(name: string) {
    const clean = setGuestName(name);
    setGuestNameState(clean);
    setNameDialog("closed");
    if (identityBase) {
      await api(identityBase, { body: { guestKey: getGuestKey(), displayName: clean } }).catch(() => undefined);
    }
  }

  const ctx: WorkspaceContext | null = view ? { view, version, comments, reload: loadView, currentTimeMs: timeMs } : null;

  if (viewError) {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center gap-3 px-6 text-center">
        <AlertTriangle className="size-6 text-warning" />
        <h1 className="text-base font-medium">{viewError.status === 410 ? "This link is no longer active" : viewError.status === 404 ? "Not available" : "Something went wrong"}</h1>
        <p className="max-w-sm text-sm text-muted-foreground">{viewError.message}</p>
        {viewError.status === 0 && (
          <button onClick={loadView} className="text-sm text-primary hover:underline">
            Try again
          </button>
        )}
      </div>
    );
  }

  const playable = view?.versions.filter((v) => v.status === "ready") ?? [];

  return (
    <div className="flex h-dvh flex-col overflow-hidden">
      <header className="flex min-h-12 shrink-0 flex-wrap items-center gap-x-3 gap-y-2 border-b bg-panel px-3 py-2">
        {backHref && (
          <Link href={backHref} className="inline-flex items-center gap-1 rounded-md px-1.5 py-1 text-xs text-muted-foreground hover:bg-accent hover:text-foreground">
            <ChevronLeft className="size-4" />
            <span className="hidden sm:inline">{backLabel}</span>
          </Link>
        )}
        <div className="min-w-0">
          <div className="truncate text-sm font-medium">{view?.video.title ?? <span className="inline-block h-4 w-40 animate-pulse rounded bg-subtle" />}</div>
          <div className="truncate text-[11px] text-muted-foreground">{view?.video.project_name}</div>
        </div>
        {view && (
          <select
            aria-label="Version"
            value={versionId ?? ""}
            onChange={(e) => {
              setVersionId(e.target.value);
              setDisplayStrokes([]);
              setStrokes([]);
            }}
            className="h-7 rounded-md border border-input bg-input/30 px-2 text-xs"
          >
            {(mode === "editor" ? view.versions : playable).map((v) => (
              <option key={v.id} value={v.id} disabled={v.status !== "ready"}>
                v{v.version_number}
                {v.id === view.video.current_version_id ? " (latest)" : ""}
                {v.source === "agent_render" ? " · agent render" : v.source === "manual_revision" ? " · revision" : ""}
                {v.status !== "ready" ? ` · ${v.status}` : ""} · {v.comment_count ?? 0} comments
              </option>
            ))}
          </select>
        )}
        {version && version.id !== view?.video.current_version_id && (
          <Pill tone="warning">Viewing an older version</Pill>
        )}
        <div className="ml-auto flex flex-wrap items-center gap-2">
          {mode === "guest" && guestName && (
            <button
              onClick={() => setNameDialog("change")}
              className="inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
            >
              Commenting as <span className="font-medium text-foreground">{guestName}</span> <Pencil className="size-3" />
            </button>
          )}
          {ctx && toolbar?.(ctx)}
        </div>
      </header>

      <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
        <div className="relative flex min-h-[260px] flex-[1.4] flex-col lg:min-h-0 lg:flex-1">
          {view ? (
            <ReviewPlayer
              ref={playerRef}
              key={version?.id ?? "none"}
              src={version?.playback_url ?? null}
              poster={version?.thumbnail_url}
              frameRate={version?.frame_rate ?? null}
              durationHintMs={version?.duration_ms ?? null}
              markers={markers}
              selectedMarkerId={selectedId}
              onMarkerClick={(id) => {
                const c = comments.find((x) => x.id === id);
                if (c) {
                  setTab("comments");
                  selectComment(c);
                }
              }}
              annotation={drawing ? strokes : displayStrokes}
              drawing={drawing}
              drawColor={color}
              onAnnotationChange={setStrokes}
              onTime={setTimeMs}
              onPlayingChange={(p) => p && !drawing && setDisplayStrokes([])}
              onMediaError={loadView}
            />
          ) : (
            <div className="flex-1 animate-pulse bg-black" />
          )}
          {version?.processing_error && (
            <div className="border-t border-warning/20 bg-warning/8 px-3 py-1.5 text-xs text-warning">{version.processing_error}</div>
          )}
        </div>

        <aside className="flex min-h-0 flex-1 flex-col border-t bg-card lg:w-[380px] lg:flex-none lg:border-t-0 lg:border-l">
          {sidebarTabs?.length ? (
            <div className="flex shrink-0 gap-1 border-b px-2 pt-2">
              {[{ id: "comments", label: `Comments (${comments.length})` }, ...sidebarTabs].map((t) => (
                <button
                  key={t.id}
                  onClick={() => setTab(t.id)}
                  className={`-mb-px border-b-2 px-3 pb-2 text-xs ${tab === t.id ? "border-primary text-foreground" : "border-transparent text-muted-foreground hover:text-foreground"}`}
                >
                  {t.label}
                </button>
              ))}
            </div>
          ) : null}
          {tab === "comments" || !sidebarTabs?.length ? (
            <CommentPanel
              comments={comments}
              loading={commentsLoading}
              error={commentsError}
              selectedId={selectedId}
              onSelect={selectComment}
              currentTimeMs={timeMs}
              canComment={Boolean(view?.permissions.can_comment && version?.status === "ready")}
              canResolve={Boolean(view?.permissions.can_resolve)}
              composer={{ drawing, strokeCount: strokes.length, color }}
              onToggleDrawing={() => {
                playerRef.current?.pause();
                setDrawing((d) => !d);
                setDisplayStrokes([]);
              }}
              onClearDrawing={() => setStrokes([])}
              onColor={setColor}
              onComposerFocus={() => playerRef.current?.pause()}
              onSubmit={submitComment}
              onReply={reply}
              onSetStatus={setStatus}
              identityLabel={
                mode === "guest" ? (
                  guestName ? (
                    <span>as {guestName}</span>
                  ) : null
                ) : (
                  <span>as editor</span>
                )
              }
            />
          ) : (
            <div className="min-h-0 flex-1 overflow-y-auto">{ctx && sidebarTabs.find((t) => t.id === tab)?.render(ctx)}</div>
          )}
        </aside>
      </div>

      {mode === "guest" && (
        <GuestNameDialog
          key={nameDialog}
          open={nameDialog !== "closed"}
          initialName={guestName}
          dismissible={nameDialog === "change"}
          onSave={saveName}
          onClose={() => setNameDialog("closed")}
        />
      )}
      <span className="sr-only" aria-live="polite">
        {selectedId ? `Selected comment at ${formatTimecode(comments.find((c) => c.id === selectedId)?.timestamp_ms)}` : ""}
      </span>
    </div>
  );
}
