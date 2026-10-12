import "server-only";
import { getDb } from "@/lib/db";
import { env } from "@/lib/env";
import { decrypt, encrypt, randomToken, sha256Hex } from "@/lib/crypto";
import { badRequest, gone, notFound } from "@/lib/http";
import { recordActivity } from "./activity";
import type { ReviewLinkDTO } from "@/shared/dto";

const TOKEN_PURPOSE = "review-link";
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/; // 32 random bytes, base64url

export function hashReviewToken(token: string) {
  return sha256Hex(`review-link:${token}`);
}

export function reviewUrl(token: string) {
  return `${env.appUrl}/r/${token}`;
}

interface LinkRow {
  id: string;
  project_id: string;
  video_id: string | null;
  video_title: string | null;
  scope: "project" | "video";
  label: string | null;
  can_comment: boolean;
  expires_at: string | null;
  revoked_at: string | null;
  last_used_at: string | null;
  created_at: string;
  token_ciphertext: string;
}

function linkState(r: { revoked_at: string | null; expires_at: string | null }): ReviewLinkDTO["state"] {
  if (r.revoked_at) return "revoked";
  if (r.expires_at && new Date(r.expires_at).getTime() <= Date.now()) return "expired";
  return "active";
}

function toDTO(r: LinkRow): ReviewLinkDTO {
  const { token_ciphertext, ...rest } = r;
  const state = linkState(r);
  const token = state === "active" ? decrypt(token_ciphertext, TOKEN_PURPOSE) : null;
  return { ...rest, state, url: token ? reviewUrl(token) : null };
}

export async function createReviewLink(
  input: { projectId: string; videoId?: string | null; label?: string | null; canComment: boolean; expiresAt?: string | null },
  actor: string,
): Promise<ReviewLinkDTO> {
  const db = await getDb();
  if (input.expiresAt && new Date(input.expiresAt).getTime() <= Date.now()) {
    throw badRequest("Expiry must be in the future");
  }
  const token = randomToken(32);
  const id = await db.tx(async (q) => {
    const [project] = await q.query<{ status: string }>("select status from projects where id = $1", [input.projectId]);
    if (!project) throw notFound("Project not found");
    if (input.videoId) {
      const [v] = await q.query<{ project_id: string }>("select project_id from videos where id = $1", [input.videoId]);
      if (!v || v.project_id !== input.projectId) throw notFound("Video not found in this project");
    }
    const [row] = await q.query<{ id: string }>(
      `insert into review_links (project_id, video_id, scope, token_hash, token_ciphertext, label, can_comment, expires_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8) returning id`,
      [
        input.projectId,
        input.videoId ?? null,
        input.videoId ? "video" : "project",
        hashReviewToken(token),
        encrypt(token, TOKEN_PURPOSE),
        input.label ?? null,
        input.canComment,
        input.expiresAt ?? null,
      ],
    );
    await recordActivity(q, {
      projectId: input.projectId,
      videoId: input.videoId ?? null,
      actorType: "editor",
      actorName: actor,
      eventType: "review_link.created",
      data: { link_id: row!.id, scope: input.videoId ? "video" : "project", can_comment: input.canComment, label: input.label ?? null },
    });
    return row!.id;
  });
  return getReviewLink(id);
}

const LINK_SELECT = `select l.id, l.project_id, l.video_id, v.title as video_title, l.scope, l.label, l.can_comment, l.expires_at,
  l.revoked_at, l.last_used_at, l.created_at, l.token_ciphertext
  from review_links l left join videos v on v.id = l.video_id`;

export async function getReviewLink(id: string): Promise<ReviewLinkDTO> {
  const db = await getDb();
  const [row] = await db.query<LinkRow>(`${LINK_SELECT} where l.id = $1`, [id]);
  if (!row) throw notFound("Review link not found");
  return toDTO(row);
}

export async function listReviewLinks(projectId: string): Promise<ReviewLinkDTO[]> {
  const db = await getDb();
  const rows = await db.query<LinkRow>(`${LINK_SELECT} where l.project_id = $1 order by l.created_at desc`, [projectId]);
  return rows.map(toDTO);
}

export async function updateReviewLink(
  id: string,
  input: { revoke?: boolean; canComment?: boolean; expiresAt?: string | null; label?: string | null },
  actor: string,
) {
  const db = await getDb();
  await db.tx(async (q) => {
    const [link] = await q.query<{ project_id: string; video_id: string | null; revoked_at: string | null }>(
      "select project_id, video_id, revoked_at from review_links where id = $1 for update",
      [id],
    );
    if (!link) throw notFound("Review link not found");
    if (input.revoke) {
      if (!link.revoked_at) {
        await q.query("update review_links set revoked_at = now() where id = $1", [id]);
        await recordActivity(q, {
          projectId: link.project_id,
          videoId: link.video_id,
          actorType: "editor",
          actorName: actor,
          eventType: "review_link.revoked",
          data: { link_id: id },
        });
      }
      return;
    }
    if (link.revoked_at) throw badRequest("Revoked links cannot be changed; create a new link instead");
    await q.query(
      `update review_links set
         can_comment = coalesce($2, can_comment),
         expires_at = case when $3::boolean then $4::timestamptz else expires_at end,
         label = case when $5::boolean then $6 else label end
       where id = $1`,
      [id, input.canComment ?? null, input.expiresAt !== undefined, input.expiresAt ?? null, input.label !== undefined, input.label ?? null],
    );
  });
}

export interface ResolvedLink {
  id: string;
  project_id: string;
  project_name: string;
  video_id: string | null;
  scope: "project" | "video";
  can_comment: boolean;
  expires_at: string | null;
}

/**
 * Validates a raw review token server-side. Throws 404 for unknown tokens and
 * 410 for revoked/expired ones. Never grants editor permissions.
 */
export async function resolveReviewToken(token: string): Promise<ResolvedLink> {
  if (!TOKEN_RE.test(token)) throw notFound("This review link is not valid.");
  const db = await getDb();
  const [row] = await db.query<ResolvedLink & { revoked_at: string | null; project_status: string; last_used_at: string | null }>(
    `select l.id, l.project_id, p.name as project_name, l.video_id, l.scope, l.can_comment, l.expires_at, l.revoked_at,
            l.last_used_at, p.status as project_status
       from review_links l join projects p on p.id = l.project_id
      where l.token_hash = $1`,
    [hashReviewToken(token)],
  );
  if (!row) throw notFound("This review link is not valid.");
  if (row.revoked_at) throw gone("This review link has been revoked. Ask the editor for a new link.");
  if (row.expires_at && new Date(row.expires_at).getTime() <= Date.now()) {
    throw gone("This review link has expired. Ask the editor for a new link.");
  }
  if (row.project_status !== "active") throw gone("This project is no longer available for review.");
  if (!row.last_used_at || Date.now() - new Date(row.last_used_at).getTime() > 5 * 60_000) {
    await db.query("update review_links set last_used_at = now() where id = $1", [row.id]);
  }
  return {
    id: row.id,
    project_id: row.project_id,
    project_name: row.project_name,
    video_id: row.video_id,
    scope: row.scope,
    can_comment: row.can_comment,
    expires_at: row.expires_at,
  };
}

/** Ensures a video is inside the link's scope and reviewable. */
export async function assertVideoInScope(link: ResolvedLink, videoId: string): Promise<void> {
  if (link.scope === "video" && link.video_id !== videoId) throw notFound("Video not found");
  const db = await getDb();
  const [v] = await db.query<{ project_id: string; status: string }>("select project_id, status from videos where id = $1", [videoId]);
  if (!v || v.project_id !== link.project_id || v.status !== "active") throw notFound("Video not found");
}
