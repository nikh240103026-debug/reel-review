"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Archive, ArchiveRestore, Film, MessageSquare, MoreHorizontal, Pencil, Share2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { PageHeader } from "@/components/app-shell";
import { ActivityFeed } from "@/components/activity-feed";
import { EmptyState, Pill, Section, StatusBadge } from "@/components/status";
import { FilePickButton, ResumeButton, UploadList, useUploads } from "@/components/editor/upload-manager";
import { CreateLinkDialog, ReviewLinksPanel } from "@/components/editor/review-links-panel";
import { api, errorText } from "@/lib/client/api";
import { formatBytes, formatDuration, timeAgo } from "@/lib/format";
import type { ActivityDTO, ProjectDTO, ReviewLinkDTO, VideoDTO } from "@/shared/dto";

export function ProjectView({
  project,
  videos,
  links,
  activity,
}: {
  project: ProjectDTO;
  videos: VideoDTO[];
  links: ReviewLinkDTO[];
  activity: ActivityDTO[];
}) {
  const router = useRouter();
  const uploads = useUploads();
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState(project.name);
  const [shareVideo, setShareVideo] = useState<string | null>(null);
  const archived = project.status === "archived";
  const active = videos.filter((v) => v.status === "active");
  const anyProcessing = uploads.items.some((i) => i.state === "active");

  // Refresh while server-side processing is in progress.
  useEffect(() => {
    if (!videos.some((v) => v.current_version?.status === "processing")) return;
    const t = setInterval(() => router.refresh(), 4000);
    return () => clearInterval(t);
  }, [videos, router]);

  async function patchProject(body: Record<string, unknown>, msg: string) {
    try {
      await api(`/api/editor/projects/${project.id}`, { method: "PATCH", body });
      toast.success(msg);
      router.refresh();
    } catch (err) {
      toast.error(errorText(err));
    }
  }

  return (
    <>
      <PageHeader
        breadcrumb={
          <Link href="/dashboard" className="hover:text-foreground">
            Projects
          </Link>
        }
        title={
          <span className="flex items-center gap-2">
            {project.name} {archived && <StatusBadge status="archived" />}
          </span>
        }
        description={project.description ?? undefined}
        actions={
          <>
            {!archived && (
              <FilePickButton onFiles={(files) => files.forEach((f) => uploads.start(f, { projectId: project.id }))} />
            )}
            <DropdownMenu>
              <DropdownMenuTrigger render={<Button variant="outline" size="icon" aria-label="Project actions" />}>
                <MoreHorizontal />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onClick={() => setRenaming(true)}>
                  <Pencil /> Rename
                </DropdownMenuItem>
                {archived ? (
                  <DropdownMenuItem onClick={() => patchProject({ status: "active" }, "Project restored")}>
                    <ArchiveRestore /> Restore
                  </DropdownMenuItem>
                ) : (
                  <DropdownMenuItem
                    onClick={() => {
                      if (confirm("Archive this project? Review links stop working while it is archived.")) patchProject({ status: "archived" }, "Project archived");
                    }}
                  >
                    <Archive /> Archive
                  </DropdownMenuItem>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          </>
        }
      />

      <div className="grid gap-6 px-4 py-6 sm:px-6 xl:grid-cols-[1fr_380px]">
        <div className="space-y-4">
          <UploadList uploads={uploads} />
          {active.length === 0 && !anyProcessing ? (
            <EmptyState
              icon={Film}
              title="No videos yet"
              description="Upload a cut to start collecting timestamped feedback. Files go straight to private storage."
              action={!archived && <FilePickButton onFiles={(files) => files.forEach((f) => uploads.start(f, { projectId: project.id }))} />}
            />
          ) : (
            <div className="overflow-hidden rounded-lg border bg-card">
              <ul className="divide-y">
                {active.map((v) => {
                  const cv = v.current_version;
                  const interrupted = cv?.status === "uploading" && !uploads.items.some((i) => i.state === "active" && i.options.videoId === v.id);
                  return (
                    <li key={v.id} className="flex flex-col gap-3 px-3 py-3 sm:flex-row sm:items-center">
                      <Link href={`/videos/${v.id}`} className="relative aspect-video w-full shrink-0 overflow-hidden rounded-md bg-subtle sm:w-40">
                        {cv?.thumbnail_url ? (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img src={cv.thumbnail_url} alt="" className="size-full object-cover" />
                        ) : (
                          <div className="flex size-full items-center justify-center text-muted-foreground">
                            <Film className="size-5" />
                          </div>
                        )}
                        {cv?.duration_ms ? (
                          <span className="absolute right-1 bottom-1 rounded bg-black/75 px-1 text-[10px] text-white tabular">{formatDuration(cv.duration_ms)}</span>
                        ) : null}
                      </Link>
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <Link href={`/videos/${v.id}`} className="truncate text-sm font-medium hover:underline">
                            {v.title}
                          </Link>
                          <Pill>v{cv?.version_number ?? "–"}</Pill>
                          {cv && cv.status !== "ready" && <StatusBadge status={interrupted ? "failed" : cv.status} />}
                          {cv?.browser_playable === false && <Pill tone="warning">Codec warning</Pill>}
                        </div>
                        <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                          <span>{v.version_count} version{v.version_count === 1 ? "" : "s"}</span>
                          {cv && <span>{formatBytes(cv.size_bytes)}</span>}
                          {cv?.width && <span>{cv.width}×{cv.height}</span>}
                          <span className="inline-flex items-center gap-1">
                            <MessageSquare className="size-3" /> {v.open_comment_count} open
                          </span>
                          <span>updated {timeAgo(v.updated_at)}</span>
                        </div>
                        {interrupted && (
                          <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-warning">
                            Upload of v{cv!.version_number} was interrupted.
                            <ResumeButton uploads={uploads} projectId={project.id} videoId={v.id} versionId={cv!.id} />
                            <Button
                              size="xs"
                              variant="ghost"
                              onClick={async () => {
                                await api(`/api/editor/uploads/${cv!.id}/abort`, { body: { reason: "Discarded interrupted upload" } }).catch((e) => toast.error(errorText(e)));
                                router.refresh();
                              }}
                            >
                              Discard
                            </Button>
                          </div>
                        )}
                        {cv?.processing_error && cv.status !== "uploading" && <p className="mt-1 text-xs text-warning">{cv.processing_error}</p>}
                      </div>
                      <div className="flex shrink-0 gap-2">
                        <Button size="sm" variant="outline" onClick={() => setShareVideo(v.id)}>
                          <Share2 /> Share
                        </Button>
                        <Button size="sm" variant="secondary" render={<Link href={`/videos/${v.id}`} />}>
                          Review
                        </Button>
                      </div>
                    </li>
                  );
                })}
              </ul>
            </div>
          )}
        </div>

        <div className="space-y-6">
          <ReviewLinksPanel projectId={project.id} links={links} videos={active.map((v) => ({ id: v.id, title: v.title }))} />
          <Section title="Project activity">
            <ActivityFeed items={activity} showContext={false} />
          </Section>
        </div>
      </div>

      <CreateLinkDialog
        key={shareVideo ?? "none"}
        projectId={project.id}
        videos={active.map((v) => ({ id: v.id, title: v.title }))}
        defaultVideoId={shareVideo}
        open={shareVideo !== null}
        onOpenChange={(o) => !o && setShareVideo(null)}
      />

      <Dialog open={renaming} onOpenChange={setRenaming}>
        <DialogContent>
          <form
            className="grid gap-4"
            onSubmit={async (e) => {
              e.preventDefault();
              await patchProject({ name }, "Project renamed");
              setRenaming(false);
            }}
          >
            <DialogHeader>
              <DialogTitle>Rename project</DialogTitle>
            </DialogHeader>
            <Input autoFocus value={name} maxLength={200} onChange={(e) => setName(e.target.value)} />
            <DialogFooter>
              <Button type="submit" disabled={!name.trim()}>
                Save
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}
