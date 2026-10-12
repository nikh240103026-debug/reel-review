import "server-only";
import { getDb } from "@/lib/db";
import { DEFAULT_WORKSPACE_ID } from "@/lib/env";
import { notFound } from "@/lib/http";
import { getStorage } from "@/lib/storage";
import { recordActivity } from "./activity";
import type { ProjectDTO } from "@/shared/dto";

const PROJECT_SELECT = `
  select p.id, p.name, p.description, p.status, p.created_at, p.updated_at,
    (select count(*) from videos v where v.project_id = p.id and v.status = 'active')::int as video_count,
    (select count(*) from comments c join videos v on v.id = c.video_id
       where v.project_id = p.id and c.parent_id is null and c.status = 'open')::int as open_comment_count,
    (select vv.thumbnail_key from videos v join video_versions vv on vv.id = v.current_version_id
       where v.project_id = p.id and v.status = 'active' and vv.thumbnail_key is not null
       order by v.updated_at desc limit 1) as thumbnail_key
  from projects p`;

type ProjectRow = Omit<ProjectDTO, "thumbnail_url"> & { thumbnail_key: string | null };

async function withThumb(rows: ProjectRow[]): Promise<ProjectDTO[]> {
  const storage = getStorage();
  return Promise.all(
    rows.map(async ({ thumbnail_key, ...p }) => ({
      ...p,
      thumbnail_url: thumbnail_key ? await storage.presignGet(thumbnail_key) : null,
    })),
  );
}

export async function listProjects(includeArchived = false): Promise<ProjectDTO[]> {
  const db = await getDb();
  const rows = await db.query<ProjectRow>(
    `${PROJECT_SELECT} where p.workspace_id = $1 ${includeArchived ? "" : "and p.status = 'active'"}
     order by p.status asc, p.updated_at desc`,
    [DEFAULT_WORKSPACE_ID],
  );
  return withThumb(rows);
}

export async function getProject(id: string): Promise<ProjectDTO> {
  const db = await getDb();
  const rows = await db.query<ProjectRow>(`${PROJECT_SELECT} where p.id = $1`, [id]);
  if (!rows[0]) throw notFound("Project not found");
  return (await withThumb(rows))[0]!;
}

export async function createProject(input: { name: string; description?: string | null }, actor: string) {
  const db = await getDb();
  return db.tx(async (q) => {
    const [row] = await q.query<{ id: string }>(
      `insert into projects (workspace_id, name, description) values ($1, $2, $3) returning id`,
      [DEFAULT_WORKSPACE_ID, input.name, input.description ?? null],
    );
    await recordActivity(q, {
      projectId: row!.id,
      actorType: "editor",
      actorName: actor,
      eventType: "project.created",
      data: { name: input.name },
    });
    return row!.id;
  });
}

export async function updateProject(
  id: string,
  input: { name?: string; description?: string | null; status?: "active" | "archived" },
  actor: string,
) {
  const db = await getDb();
  await db.tx(async (q) => {
    const [existing] = await q.query<{ name: string; status: string }>(
      "select name, status from projects where id = $1 for update",
      [id],
    );
    if (!existing) throw notFound("Project not found");
    await q.query(
      `update projects set
         name = coalesce($2, name),
         description = case when $3::boolean then $4 else description end,
         status = coalesce($5, status),
         archived_at = case when $5 = 'archived' then now() when $5 = 'active' then null else archived_at end
       where id = $1`,
      [id, input.name ?? null, input.description !== undefined, input.description ?? null, input.status ?? null],
    );
    if (input.name && input.name !== existing.name) {
      await recordActivity(q, {
        projectId: id,
        actorType: "editor",
        actorName: actor,
        eventType: "project.renamed",
        data: { from: existing.name, to: input.name },
      });
    }
    if (input.status && input.status !== existing.status) {
      await recordActivity(q, {
        projectId: id,
        actorType: "editor",
        actorName: actor,
        eventType: input.status === "archived" ? "project.archived" : "project.restored",
      });
    }
  });
}

export async function dashboardStats() {
  const db = await getDb();
  const [row] = await db.query<Record<string, number>>(
    `select
      (select count(*) from projects where status = 'active')::int as projects,
      (select count(*) from videos v join projects p on p.id = v.project_id where v.status = 'active' and p.status = 'active')::int as videos,
      (select count(*) from comments where parent_id is null and status = 'open')::int as open_comments,
      (select count(*) from edit_proposals where status in ('awaiting_approval', 'needs_clarification'))::int as proposals_pending,
      (select count(*) from edit_jobs where status in ('queued', 'running'))::int as jobs_active,
      (select count(*) from edit_jobs where status = 'failed' and finished_at > now() - interval '7 days')::int as jobs_failed_recent,
      (select count(*) from agent_devices where status = 'active' and last_seen_at > now() - interval '90 seconds')::int as devices_online`,
  );
  return row!;
}
