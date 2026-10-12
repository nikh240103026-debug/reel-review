import "server-only";
import { getDb, type Queryable } from "@/lib/db";
import { DEFAULT_WORKSPACE_ID } from "@/lib/env";
import type { ActivityDTO } from "@/shared/dto";

export interface ActivityInput {
  projectId?: string | null;
  videoId?: string | null;
  actorType: ActivityDTO["actor_type"];
  actorName?: string | null;
  eventType: string;
  data?: Record<string, unknown>;
}

export async function recordActivity(q: Queryable, a: ActivityInput): Promise<void> {
  await q.query(
    `insert into activity_events (workspace_id, project_id, video_id, actor_type, actor_name, event_type, data)
     values ($1, $2, $3, $4, $5, $6, $7::jsonb)`,
    [
      DEFAULT_WORKSPACE_ID,
      a.projectId ?? null,
      a.videoId ?? null,
      a.actorType,
      a.actorName ?? null,
      a.eventType,
      JSON.stringify(a.data ?? {}),
    ],
  );
}

export async function listActivity(opts: { projectId?: string; videoId?: string; limit?: number } = {}): Promise<ActivityDTO[]> {
  const db = await getDb();
  const where: string[] = [];
  const params: unknown[] = [];
  if (opts.projectId) {
    params.push(opts.projectId);
    where.push(`a.project_id = $${params.length}`);
  }
  if (opts.videoId) {
    params.push(opts.videoId);
    where.push(`a.video_id = $${params.length}`);
  }
  params.push(Math.min(opts.limit ?? 30, 200));
  return db.query<ActivityDTO>(
    `select a.id, a.project_id, a.video_id, a.actor_type, a.actor_name, a.event_type, a.data, a.created_at,
            p.name as project_name, v.title as video_title
       from activity_events a
       left join projects p on p.id = a.project_id
       left join videos v on v.id = a.video_id
      ${where.length ? "where " + where.join(" and ") : ""}
      order by a.created_at desc
      limit $${params.length}`,
    params,
  );
}
