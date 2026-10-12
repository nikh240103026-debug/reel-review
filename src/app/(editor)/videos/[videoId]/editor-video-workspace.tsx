"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Download, Loader2, Share2, Sparkles, Upload } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { ReviewWorkspace, type WorkspaceContext } from "@/components/review/review-workspace";
import { CreateLinkDialog } from "@/components/editor/review-links-panel";
import { FilePickButton, UploadList, useUploads } from "@/components/editor/upload-manager";
import { Pill, StatusBadge } from "@/components/status";
import { api, errorText } from "@/lib/client/api";
import { timeAgo } from "@/lib/format";
import { ADAPTERS, type AdapterId } from "@/shared/operations";
import type { ProposalDTO } from "@/shared/dto";

export function EditorVideoWorkspace({
  videoId,
  projectId,
  projectName,
  claudeConfigured,
  claudeModel,
  activeAdapters,
}: {
  videoId: string;
  projectId: string;
  projectName: string;
  claudeConfigured: boolean;
  claudeModel: string;
  activeAdapters: string[];
}) {
  const [share, setShare] = useState(false);
  const [aiOpen, setAiOpen] = useState(false);
  const [uploadOpen, setUploadOpen] = useState(false);
  const uploads = useUploads(() => {
    setUploadOpen(false);
  });

  return (
    <>
      <ReviewWorkspace
        mode="editor"
        apiBase={`/api/editor/videos/${videoId}`}
        backHref={`/projects/${projectId}`}
        backLabel={projectName}
        toolbar={(ctx) => (
          <>
            <Button size="sm" variant="outline" onClick={() => setUploadOpen(true)}>
              <Upload /> <span className="hidden sm:inline">New version</span>
            </Button>
            <Button size="sm" variant="outline" onClick={() => setShare(true)}>
              <Share2 /> <span className="hidden sm:inline">Share</span>
            </Button>
            {ctx.version?.status === "ready" && (
              <Button
                size="sm"
                variant="ghost"
                aria-label="Download this version"
                onClick={async () => {
                  try {
                    const { url } = await api<{ url: string }>(`/api/editor/videos/${videoId}/download?versionId=${ctx.version!.id}`);
                    window.location.href = url;
                  } catch (err) {
                    toast.error(errorText(err));
                  }
                }}
              >
                <Download />
              </Button>
            )}
            <Button size="sm" onClick={() => setAiOpen(true)} disabled={!ctx.version || ctx.version.status !== "ready"}>
              <Sparkles /> AI Review
            </Button>
            <AiReviewDialog
              open={aiOpen}
              onOpenChange={setAiOpen}
              ctx={ctx}
              videoId={videoId}
              claudeConfigured={claudeConfigured}
              claudeModel={claudeModel}
              activeAdapters={activeAdapters}
            />
            <Dialog open={uploadOpen} onOpenChange={setUploadOpen}>
              <DialogContent className="sm:max-w-md">
                <DialogHeader>
                  <DialogTitle>Upload a new version</DialogTitle>
                  <DialogDescription>
                    Creates v{(ctx.view.versions[0]?.version_number ?? 0) + 1}. Previous versions and their comments are preserved and never moved.
                  </DialogDescription>
                </DialogHeader>
                <UploadList uploads={uploads} />
                <DialogFooter>
                  <FilePickButton multiple={false} onFiles={([f]) => f && uploads.start(f, { projectId, videoId })}>
                    <Upload /> Choose file
                  </FilePickButton>
                </DialogFooter>
              </DialogContent>
            </Dialog>
          </>
        )}
        sidebarTabs={[{ id: "proposals", label: "AI proposals", render: () => <ProposalList videoId={videoId} /> }]}
      />
      <CreateLinkDialog projectId={projectId} videos={[]} defaultVideoId={videoId} open={share} onOpenChange={setShare} />
    </>
  );
}

function ProposalList({ videoId }: { videoId: string }) {
  const [items, setItems] = useState<ProposalDTO[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    async function load() {
      try {
        const { proposals } = await api<{ proposals: ProposalDTO[] }>(`/api/editor/proposals?videoId=${videoId}`);
        if (active) setItems(proposals);
      } catch (err) {
        if (active) setError(errorText(err));
      }
    }
    void load();
    return () => {
      active = false;
    };
  }, [videoId]);
  if (error) return <p className="p-4 text-sm text-destructive">{error}</p>;
  if (!items) return <div className="m-3 h-20 animate-pulse rounded-lg bg-subtle" />;
  if (!items.length)
    return <p className="p-6 text-center text-sm text-muted-foreground">No proposals yet. Use AI Review to analyze unresolved comments.</p>;
  return (
    <ul className="divide-y">
      {items.map((p) => (
        <li key={p.id}>
          <Link href={`/proposals/${p.id}`} className="block px-4 py-3 hover:bg-subtle">
            <div className="flex items-center gap-2">
              <span className="text-[13px] font-medium">Revision {p.revision}</span>
              <StatusBadge status={p.status} />
            </div>
            <div className="mt-1 text-xs text-muted-foreground">
              Source v{p.source_version_number} · {p.op_counts?.total} operations · {ADAPTERS[p.adapter as AdapterId]?.label ?? p.adapter} ·{" "}
              {p.generator === "claude" ? "Claude" : "Offline draft (no AI)"} · {timeAgo(p.created_at)}
            </div>
            {p.summary && <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">{p.summary}</p>}
          </Link>
        </li>
      ))}
    </ul>
  );
}

function AiReviewDialog({
  open,
  onOpenChange,
  ctx,
  videoId,
  claudeConfigured,
  claudeModel,
  activeAdapters,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  ctx: WorkspaceContext;
  videoId: string;
  claudeConfigured: boolean;
  claudeModel: string;
  activeAdapters: string[];
}) {
  const router = useRouter();
  const implemented = Object.values(ADAPTERS).filter((a) => a.implemented);
  const [adapter, setAdapter] = useState<AdapterId>(activeAdapters.includes("ffmpeg") ? "ffmpeg" : "manual");
  const [mode, setMode] = useState<"claude" | "offline">(claudeConfigured ? "claude" : "offline");
  const [busy, setBusy] = useState(false);
  const unresolved = ctx.comments.filter((c) => c.status === "open" && c.author_type !== "ai").length;

  async function run() {
    if (!ctx.version) return;
    setBusy(true);
    try {
      const { proposalId } = await api<{ proposalId: string }>(`/api/editor/videos/${videoId}/ai-review`, {
        body: { versionId: ctx.version.id, adapter, mode },
      });
      toast.success("Proposal created. Review it before anything runs.");
      router.push(`/proposals/${proposalId}`);
    } catch (err) {
      toast.error(errorText(err));
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !busy && onOpenChange(o)}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>AI Review · v{ctx.version?.version_number}</DialogTitle>
          <DialogDescription>
            Analyzes the {unresolved} unresolved comment{unresolved === 1 ? "" : "s"} on this version and drafts structured edit operations. Nothing is executed:
            you review, edit and approve every operation first.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-4">
          <fieldset className="grid gap-2">
            <legend className="mb-1 text-xs font-medium text-muted-foreground">Analysis</legend>
            <label className={`flex items-start gap-3 rounded-lg border p-3 ${!claudeConfigured ? "opacity-50" : "cursor-pointer"} ${mode === "claude" ? "border-primary/60 bg-primary/5" : ""}`}>
              <input type="radio" name="mode" disabled={!claudeConfigured} checked={mode === "claude"} onChange={() => setMode("claude")} className="mt-1 accent-primary" />
              <div>
                <div className="text-sm">Claude</div>
                <div className="text-xs text-muted-foreground">
                  {claudeConfigured ? `Model ${claudeModel}. Interprets feedback, asks for clarification when ambiguous.` : "Not configured: set ANTHROPIC_API_KEY on the server."}
                </div>
              </div>
            </label>
            <label className={`flex cursor-pointer items-start gap-3 rounded-lg border p-3 ${mode === "offline" ? "border-primary/60 bg-primary/5" : ""}`}>
              <input type="radio" name="mode" checked={mode === "offline"} onChange={() => setMode("offline")} className="mt-1 accent-primary" />
              <div>
                <div className="flex items-center gap-2 text-sm">
                  Offline draft <Pill tone="warning">Not AI</Pill>
                </div>
                <div className="text-xs text-muted-foreground">Copies each comment verbatim into a manual checklist task. No interpretation.</div>
              </div>
            </label>
          </fieldset>

          <fieldset className="grid gap-2">
            <legend className="mb-1 text-xs font-medium text-muted-foreground">Target editing adapter</legend>
            {implemented.map((a) => (
              <label key={a.id} className={`flex cursor-pointer items-start gap-3 rounded-lg border p-3 ${adapter === a.id ? "border-primary/60 bg-primary/5" : ""}`}>
                <input type="radio" name="adapter" checked={adapter === a.id} onChange={() => setAdapter(a.id)} className="mt-1 accent-primary" />
                <div>
                  <div className="flex items-center gap-2 text-sm">
                    {a.label}
                    {a.automated ? <Pill tone="info">Automated</Pill> : <Pill>Human-performed</Pill>}
                    {!activeAdapters.includes(a.id) && <Pill tone="warning">No device online</Pill>}
                  </div>
                  <div className="text-xs text-muted-foreground">{a.summary}</div>
                </div>
              </label>
            ))}
            <p className="text-xs text-muted-foreground">These adapters render flattened-video edits with FFmpeg, then open the render in the selected editor for human review. They do not modify existing editor project files.</p>
          </fieldset>
        </div>

        <DialogFooter>
          <Button onClick={run} disabled={busy || unresolved === 0}>
            {busy ? <Loader2 className="animate-spin" /> : <Sparkles />}
            {busy ? (mode === "claude" ? "Claude is analyzing…" : "Drafting…") : unresolved === 0 ? "No unresolved comments" : "Generate proposal"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
