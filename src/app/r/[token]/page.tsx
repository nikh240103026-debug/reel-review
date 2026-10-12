import Link from "next/link";
import { redirect } from "next/navigation";
import { Clapperboard, Film, Play } from "lucide-react";
import { listVideos } from "@/lib/services/videos";
import { formatDuration } from "@/lib/format";
import { LinkError, resolveForPage } from "./link-error";

export const metadata = { title: "Review" };

export default async function GuestProjectPage({ params }: PageProps<"/r/[token]">) {
  const { token } = await params;
  const res = await resolveForPage(token);
  if ("error" in res) return <LinkError error={res.error} />;
  const { link } = res;
  if (link.scope === "video" && link.video_id) redirect(`/r/${token}/v/${link.video_id}`);

  const videos = (await listVideos(link.project_id)).filter((v) => v.current_version_id);

  return (
    <div className="min-h-screen">
      <header className="flex h-12 items-center gap-2 border-b bg-panel px-4">
        <Clapperboard className="size-4 text-primary" />
        <span className="text-sm font-medium">{link.project_name}</span>
        <span className="text-xs text-muted-foreground">· {link.can_comment ? "Review & comment" : "View only"}</span>
      </header>
      <main className="mx-auto max-w-5xl px-4 py-8">
        <h1 className="text-lg font-semibold tracking-tight">Videos for review</h1>
        <p className="mt-1 text-sm text-muted-foreground">Pick a video, press play, and pause anywhere to leave timestamped feedback. No account needed.</p>
        {videos.length === 0 ? (
          <div className="mt-8 rounded-lg border border-dashed px-6 py-12 text-center text-sm text-muted-foreground">
            There are no videos ready for review yet. Check back soon.
          </div>
        ) : (
          <div className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {videos.map((v) => (
              <Link key={v.id} href={`/r/${token}/v/${v.id}`} className="group overflow-hidden rounded-lg border bg-card hover:border-white/15">
                <div className="relative aspect-video bg-subtle">
                  {v.current_version?.status === "ready" && v.current_version.thumbnail_url ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={v.current_version.thumbnail_url} alt="" className="size-full object-cover" />
                  ) : (
                    <div className="flex size-full items-center justify-center text-muted-foreground">
                      <Film className="size-6" />
                    </div>
                  )}
                  <span className="absolute inset-0 flex items-center justify-center opacity-0 transition-opacity group-hover:opacity-100">
                    <span className="rounded-full bg-black/70 p-3">
                      <Play className="size-5 text-white" />
                    </span>
                  </span>
                  {v.current_version?.duration_ms ? (
                    <span className="absolute right-1.5 bottom-1.5 rounded bg-black/75 px-1.5 text-[11px] text-white tabular">
                      {formatDuration(v.current_version.duration_ms)}
                    </span>
                  ) : null}
                </div>
                <div className="px-3 py-2.5">
                  <div className="truncate text-sm font-medium">{v.title}</div>
                  <div className="text-xs text-muted-foreground">
                    Version {v.current_version?.version_number} · {v.open_comment_count} open comment{v.open_comment_count === 1 ? "" : "s"}
                  </div>
                </div>
              </Link>
            ))}
          </div>
        )}
      </main>
    </div>
  );
}
