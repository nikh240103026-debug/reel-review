import "server-only";
import { z } from "zod";
import { getDb } from "@/lib/db";
import { notFound } from "@/lib/http";
import { listVersions } from "./videos";
import { AnnotationSchema, CommentBody } from "./comments";
import type { VideoVersionDTO } from "@/shared/dto";

export interface ReviewVideoView {
  video: { id: string; title: string; project_id: string; project_name: string; current_version_id: string | null };
  versions: VideoVersionDTO[];
  permissions: { can_comment: boolean; can_resolve: boolean; is_editor: boolean };
}

/** Same shape for the guest and the editor review screens. Guests only see ready versions. */
export async function buildReviewView(videoId: string, opts: { isEditor: boolean; canComment: boolean }): Promise<ReviewVideoView> {
  const db = await getDb();
  const [video] = await db.query<ReviewVideoView["video"]>(
    `select v.id, v.title, v.project_id, p.name as project_name, v.current_version_id
       from videos v join projects p on p.id = v.project_id where v.id = $1`,
    [videoId],
  );
  if (!video) throw notFound("Video not found");
  const versions = await listVersions(videoId, { withPlayback: true, readyOnly: !opts.isEditor });
  return {
    video,
    versions,
    permissions: { can_comment: opts.canComment, can_resolve: opts.canComment, is_editor: opts.isEditor },
  };
}

export const NewCommentRequest = z.object({
  versionId: z.string().uuid(),
  body: CommentBody,
  timestampMs: z.number().int().min(0).max(24 * 3600 * 1000).nullable().optional(),
  parentId: z.string().uuid().nullable().optional(),
  annotation: AnnotationSchema.nullable().optional(),
});

export const CommentStatusRequest = z.object({ status: z.enum(["open", "resolved"]) });
