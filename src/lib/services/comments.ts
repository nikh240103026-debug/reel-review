import "server-only";
import { z } from "zod";
import { getDb, type Queryable } from "@/lib/db";
import { sha256Hex } from "@/lib/crypto";
import { badRequest, conflict, notFound } from "@/lib/http";
import { recordActivity } from "./activity";
import type { AttachmentDTO, AuthorType, CommentDTO } from "@/shared/dto";

export const DisplayName = z
  .string()
  .transform((s) => s.replace(/[\u0000-\u001f\u007f]/g, "").replace(/\s+/g, " ").trim())
  .pipe(z.string().min(1, "Name is required").max(80, "Name is too long"));

export const CommentBody = z
  .string()
  .transform((s) => s.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").trim())
  .pipe(z.string().min(1, "Comment cannot be empty").max(5000, "Comment is too long (5000 characters max)"));

export const AnnotationSchema = z
  .object({
    strokes: z
      .array(
        z.object({
          color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
          width: z.number().min(0.001).max(0.05),
          points: z.array(z.tuple([z.number().min(0).max(1), z.number().min(0).max(1)])).min(1).max(1000),
        }),
      )
      .min(1)
      .max(40),
  })
  .refine((a) => a.strokes.reduce((n, s) => n + s.points.length, 0) <= 4000, "Annotation is too detailed");

export const GuestKey = z.string().regex(/^[A-Za-z0-9_-]{16,64}$/);

export async function upsertGuestIdentity(linkId: string, guestKey: string, displayName: string): Promise<string> {
  const db = await getDb();
  const [row] = await db.query<{ id: string }>(
    `insert into guest_identities (review_link_id, client_key_hash, display_name) values ($1, $2, $3)
     on conflict (review_link_id, client_key_hash)
       do update set display_name = excluded.display_name, last_seen_at = now()
     returning id`,
    [linkId, sha256Hex(`guest:${guestKey}`), displayName],
  );
  return row!.id;
}

export async function findGuestIdentity(linkId: string, guestKey: string | null): Promise<string | null> {
  if (!guestKey || !GuestKey.safeParse(guestKey).success) return null;
  const db = await getDb();
  const [row] = await db.query<{ id: string }>(
    "select id from guest_identities where review_link_id = $1 and client_key_hash = $2",
    [linkId, sha256Hex(`guest:${guestKey}`)],
  );
  return row?.id ?? null;
}

type CommentRow = Omit<CommentDTO, "attachments" | "replies" | "is_mine"> & { guest_identity_id: string | null };

export async function listComments(versionId: string, opts: { viewerGuestIdentityId?: string | null } = {}): Promise<CommentDTO[]> {
  const db = await getDb();
  const rows = await db.query<CommentRow>(
    `select id, video_id, video_version_id, parent_id, author_type, author_name, body, timestamp_ms, status,
            resolved_at, resolved_by_name, created_at, guest_identity_id
       from comments where video_version_id = $1
       order by parent_id nulls first, timestamp_ms nulls last, created_at`,
    [versionId],
  );
  const attachments = rows.length
    ? await db.query<AttachmentDTO & { comment_id: string }>(
        `select a.id, a.comment_id, a.kind, a.data from comment_attachments a
           join comments c on c.id = a.comment_id where c.video_version_id = $1`,
        [versionId],
      )
    : [];
  const byComment = new Map<string, AttachmentDTO[]>();
  for (const a of attachments) {
    const list = byComment.get(a.comment_id) ?? [];
    list.push({ id: a.id, kind: a.kind, data: a.data });
    byComment.set(a.comment_id, list);
  }
  const top: CommentDTO[] = [];
  const index = new Map<string, CommentDTO>();
  for (const r of rows) {
    const { guest_identity_id, ...rest } = r;
    const dto: CommentDTO = {
      ...rest,
      is_mine: Boolean(opts.viewerGuestIdentityId && guest_identity_id === opts.viewerGuestIdentityId),
      attachments: byComment.get(r.id) ?? [],
      replies: [],
    };
    index.set(r.id, dto);
    if (!r.parent_id) top.push(dto);
  }
  for (const r of rows) {
    if (r.parent_id) index.get(r.parent_id)?.replies.push(index.get(r.id)!);
  }
  top.sort((a, b) => (a.timestamp_ms ?? 0) - (b.timestamp_ms ?? 0) || a.created_at.localeCompare(b.created_at));
  return top;
}

export interface CreateCommentInput {
  videoId: string;
  versionId: string;
  parentId?: string | null;
  authorType: AuthorType;
  authorName: string;
  guestIdentityId?: string | null;
  reviewLinkId?: string | null;
  body: string;
  timestampMs?: number | null;
  annotation?: z.infer<typeof AnnotationSchema> | null;
}

export async function createComment(input: CreateCommentInput, q?: Queryable): Promise<string> {
  const db = await getDb();
  const run = async (tx: Queryable) => {
    const [version] = await tx.query<{ video_id: string; status: string; duration_ms: number | null; project_id: string; version_number: number }>(
      `select vv.video_id, vv.status, vv.duration_ms, v.project_id, vv.version_number
         from video_versions vv join videos v on v.id = vv.video_id where vv.id = $1`,
      [input.versionId],
    );
    if (!version || version.video_id !== input.videoId) throw notFound("Video version not found");
    if (version.status !== "ready") throw conflict("This version is not ready for review yet");

    let timestamp = input.timestampMs ?? null;
    if (input.parentId) {
      const [parent] = await tx.query<{ video_version_id: string; parent_id: string | null }>(
        "select video_version_id, parent_id from comments where id = $1",
        [input.parentId],
      );
      if (!parent || parent.video_version_id !== input.versionId) throw notFound("Parent comment not found");
      if (parent.parent_id) throw badRequest("Replies can only be added to top-level comments");
      timestamp = null;
      if (input.annotation) throw badRequest("Replies cannot carry annotations");
    } else {
      if (timestamp === null || !Number.isInteger(timestamp) || timestamp < 0) {
        throw badRequest("A comment needs the playback timestamp in integer milliseconds");
      }
      if (version.duration_ms && timestamp > version.duration_ms + 1000) {
        throw badRequest("Timestamp is beyond the end of the video");
      }
    }

    const [row] = await tx.query<{ id: string }>(
      `insert into comments (video_id, video_version_id, parent_id, author_type, author_name, guest_identity_id, review_link_id, body, timestamp_ms)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9) returning id`,
      [
        input.videoId,
        input.versionId,
        input.parentId ?? null,
        input.authorType,
        input.authorName,
        input.guestIdentityId ?? null,
        input.reviewLinkId ?? null,
        input.body,
        timestamp,
      ],
    );
    if (input.annotation) {
      await tx.query(`insert into comment_attachments (comment_id, kind, data) values ($1, 'annotation', $2::jsonb)`, [
        row!.id,
        JSON.stringify(input.annotation),
      ]);
    }
    await recordActivity(tx, {
      projectId: version.project_id,
      videoId: input.videoId,
      actorType: input.authorType === "client" ? "client" : input.authorType === "ai" ? "ai" : "editor",
      actorName: input.authorName,
      eventType: input.parentId ? "comment.replied" : "comment.created",
      data: {
        comment_id: row!.id,
        version_number: version.version_number,
        timestamp_ms: timestamp,
        excerpt: input.body.slice(0, 140),
      },
    });
    return row!.id;
  };
  return q ? run(q) : db.tx(run);
}

export async function setCommentStatus(
  commentId: string,
  status: "open" | "resolved",
  actor: { name: string; type: "client" | "editor" },
  scope: { videoId: string },
) {
  const db = await getDb();
  await db.tx(async (q) => {
    const [c] = await q.query<{ video_id: string; parent_id: string | null; status: string; project_id: string }>(
      `select c.video_id, c.parent_id, c.status, v.project_id from comments c join videos v on v.id = c.video_id where c.id = $1 for update of c`,
      [commentId],
    );
    if (!c || c.video_id !== scope.videoId) throw notFound("Comment not found");
    if (c.parent_id) throw badRequest("Only top-level comments can be resolved");
    if (c.status === status) return;
    await q.query(
      `update comments set status = $2,
         resolved_at = case when $2 = 'resolved' then now() else null end,
         resolved_by_name = case when $2 = 'resolved' then $3 else null end
       where id = $1`,
      [commentId, status, actor.name],
    );
    await recordActivity(q, {
      projectId: c.project_id,
      videoId: c.video_id,
      actorType: actor.type,
      actorName: actor.name,
      eventType: status === "resolved" ? "comment.resolved" : "comment.reopened",
      data: { comment_id: commentId },
    });
  });
}
