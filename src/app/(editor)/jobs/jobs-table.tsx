"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { ListChecks } from "lucide-react";
import { EmptyState, StatusBadge } from "@/components/status";
import { Progress } from "@/components/ui/progress";
import { api } from "@/lib/client/api";
import { timeAgo } from "@/lib/format";
import { ADAPTERS, type AdapterId } from "@/shared/operations";
import type { JobDTO } from "@/shared/dto";

export function JobsTable({ initial }: { initial: JobDTO[] }) {
  const [jobs, setJobs] = useState(initial);
  const [stale, setStale] = useState(false);

  useEffect(() => {
    const t = setInterval(async () => {
      if (document.visibilityState !== "visible") return;
      try {
        const { jobs } = await api<{ jobs: JobDTO[] }>("/api/editor/jobs");
        setJobs(jobs);
        setStale(false);
      } catch {
        setStale(true);
      }
    }, 5000);
    return () => clearInterval(t);
  }, []);

  if (!jobs.length)
    return (
      <EmptyState
        icon={ListChecks}
        title="No jobs yet"
        description="Approve a proposal and queue it. A registered local agent will pick it up."
      />
    );

  return (
    <>
      {stale && <p className="mb-3 text-xs text-warning">Connection lost; showing the last known status.</p>}
      <div className="overflow-x-auto rounded-lg border bg-card">
        <table className="w-full min-w-[760px] text-[13px]">
          <thead className="border-b text-left text-xs text-muted-foreground">
            <tr>
              <th className="px-4 py-2 font-normal">Video</th>
              <th className="px-4 py-2 font-normal">Adapter</th>
              <th className="px-4 py-2 font-normal">Device</th>
              <th className="px-4 py-2 font-normal">Progress</th>
              <th className="px-4 py-2 font-normal">Attempts</th>
              <th className="px-4 py-2 font-normal">Status</th>
              <th className="px-4 py-2 font-normal">Created</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {jobs.map((j) => (
              <tr key={j.id} className="hover:bg-subtle">
                <td className="px-4 py-2.5">
                  <Link href={`/jobs/${j.id}`} className="font-medium hover:underline">
                    {j.video_title}
                  </Link>
                  <div className="text-xs text-muted-foreground">
                    {j.project_name} · proposal rev {j.proposal_revision}
                  </div>
                </td>
                <td className="px-4 py-2.5 text-xs">{ADAPTERS[j.adapter as AdapterId]?.label ?? j.adapter}</td>
                <td className="px-4 py-2.5 text-xs text-muted-foreground">{j.claimed_by_device_name ?? j.target_device_name ?? "Any"}</td>
                <td className="w-40 px-4 py-2.5">
                  {j.status === "running" ? (
                    <div>
                      <Progress value={Math.round(j.progress * 100)} className="h-1" />
                      <div className="mt-1 truncate text-[11px] text-muted-foreground">{j.progress_message}</div>
                    </div>
                  ) : j.status === "completed" && j.result_version_number ? (
                    <span className="text-xs text-success">Created v{j.result_version_number}</span>
                  ) : j.error ? (
                    <span className="line-clamp-1 text-xs text-destructive">{j.error}</span>
                  ) : (
                    <span className="text-xs text-muted-foreground">—</span>
                  )}
                </td>
                <td className="px-4 py-2.5 text-xs tabular">
                  {j.attempts}/{j.max_attempts}
                </td>
                <td className="px-4 py-2.5">
                  <StatusBadge status={j.status} />
                </td>
                <td className="px-4 py-2.5 text-xs text-muted-foreground">{timeAgo(j.created_at)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
