import Link from "next/link";
import { Film, FolderOpen, MessageSquare, Sparkles, ListChecks, Cpu } from "lucide-react";
import { PageHeader } from "@/components/app-shell";
import { ActivityFeed } from "@/components/activity-feed";
import { EmptyState, Section, StatusBadge } from "@/components/status";
import { NewProjectButton } from "@/components/editor/new-project-button";
import { dashboardStats, listProjects } from "@/lib/services/projects";
import { listActivity } from "@/lib/services/activity";
import { listProposals } from "@/lib/services/proposals";
import { listJobs } from "@/lib/services/jobs";
import { timeAgo } from "@/lib/format";

export const metadata = { title: "Dashboard" };

export default async function DashboardPage() {
  const [stats, projects, activity, proposals, jobs] = await Promise.all([
    dashboardStats(),
    listProjects(),
    listActivity({ limit: 25 }),
    listProposals({ statuses: ["awaiting_approval", "needs_clarification", "approved"], limit: 8 }),
    listJobs({ statuses: ["queued", "running"], limit: 8 }),
  ]);

  const tiles = [
    { label: "Active projects", value: stats.projects, icon: FolderOpen },
    { label: "Videos", value: stats.videos, icon: Film },
    { label: "Open comments", value: stats.open_comments, icon: MessageSquare },
    { label: "Awaiting approval", value: stats.proposals_pending, icon: Sparkles, href: "/proposals" },
    { label: "Jobs in progress", value: stats.jobs_active, icon: ListChecks, href: "/jobs" },
    { label: "Devices online", value: stats.devices_online, icon: Cpu, href: "/settings" },
  ];

  return (
    <>
      <PageHeader title="Dashboard" description="Projects, client feedback and editing work across your agency." actions={<NewProjectButton />} />
      <div className="space-y-6 px-4 py-6 sm:px-6">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-6">
          {tiles.map((t) => {
            const inner = (
              <div className="rounded-lg border bg-card px-4 py-3 transition-colors hover:bg-subtle">
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  <t.icon className="size-3.5" />
                  {t.label}
                </div>
                <div className="mt-1 text-2xl font-semibold tabular">{t.value}</div>
              </div>
            );
            return t.href ? (
              <Link key={t.label} href={t.href}>
                {inner}
              </Link>
            ) : (
              <div key={t.label}>{inner}</div>
            );
          })}
        </div>

        {stats.jobs_failed_recent > 0 && (
          <Link href="/jobs" className="block rounded-lg border border-destructive/30 bg-destructive/8 px-4 py-2.5 text-sm text-destructive">
            {stats.jobs_failed_recent} editing job{stats.jobs_failed_recent === 1 ? "" : "s"} failed in the last 7 days. Review the logs.
          </Link>
        )}

        <div className="grid gap-6 xl:grid-cols-[1fr_380px]">
          <div className="space-y-6">
            <div>
              <div className="mb-3 flex items-center justify-between">
                <h2 className="text-sm font-medium">Projects</h2>
              </div>
              {projects.length === 0 ? (
                <EmptyState
                  icon={FolderOpen}
                  title="No projects yet"
                  description="Create a project, upload a cut, and share a private review link with your client."
                  action={<NewProjectButton />}
                />
              ) : (
                <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                  {projects.map((p) => (
                    <Link key={p.id} href={`/projects/${p.id}`} className="group overflow-hidden rounded-lg border bg-card transition-colors hover:border-white/15">
                      <div className="relative aspect-video bg-subtle">
                        {p.thumbnail_url ? (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img src={p.thumbnail_url} alt="" className="size-full object-cover opacity-90 transition-opacity group-hover:opacity-100" />
                        ) : (
                          <div className="flex size-full items-center justify-center text-muted-foreground">
                            <Film className="size-6" />
                          </div>
                        )}
                        {p.open_comment_count > 0 && (
                          <span className="absolute top-2 right-2 inline-flex items-center gap-1 rounded-full bg-black/70 px-2 py-0.5 text-[11px] text-white">
                            <MessageSquare className="size-3" /> {p.open_comment_count}
                          </span>
                        )}
                      </div>
                      <div className="px-3 py-2.5">
                        <div className="truncate text-sm font-medium">{p.name}</div>
                        <div className="mt-0.5 text-xs text-muted-foreground">
                          {p.video_count} video{p.video_count === 1 ? "" : "s"} · updated {timeAgo(p.updated_at)}
                        </div>
                      </div>
                    </Link>
                  ))}
                </div>
              )}
            </div>

            <div className="grid gap-6 lg:grid-cols-2">
              <Section title="Proposals needing you">
                {proposals.length === 0 ? (
                  <p className="px-4 py-6 text-center text-sm text-muted-foreground">Nothing awaiting approval.</p>
                ) : (
                  <ul className="divide-y">
                    {proposals.map((p) => (
                      <li key={p.id}>
                        <Link href={`/proposals/${p.id}`} className="flex items-center justify-between gap-3 px-4 py-2.5 hover:bg-subtle">
                          <div className="min-w-0">
                            <div className="truncate text-[13px] font-medium">{p.video_title}</div>
                            <div className="text-xs text-muted-foreground">
                              Rev {p.revision} · {p.op_counts?.total} ops · {timeAgo(p.created_at)}
                            </div>
                          </div>
                          <StatusBadge status={p.status} />
                        </Link>
                      </li>
                    ))}
                  </ul>
                )}
              </Section>
              <Section title="Editing jobs in progress">
                {jobs.length === 0 ? (
                  <p className="px-4 py-6 text-center text-sm text-muted-foreground">No queued or running jobs.</p>
                ) : (
                  <ul className="divide-y">
                    {jobs.map((j) => (
                      <li key={j.id}>
                        <Link href={`/jobs/${j.id}`} className="flex items-center justify-between gap-3 px-4 py-2.5 hover:bg-subtle">
                          <div className="min-w-0">
                            <div className="truncate text-[13px] font-medium">{j.video_title}</div>
                            <div className="text-xs text-muted-foreground">
                              {j.adapter} · {j.claimed_by_device_name ?? "waiting for a device"}
                            </div>
                          </div>
                          <StatusBadge status={j.status} />
                        </Link>
                      </li>
                    ))}
                  </ul>
                )}
              </Section>
            </div>
          </div>

          <Section title="Recent activity" className="h-fit">
            <ActivityFeed items={activity} />
          </Section>
        </div>
      </div>
    </>
  );
}
