import { handler, json, type Ctx } from "@/lib/http";
import { guestAccess } from "@/lib/services/guest-access";
import { listVideos } from "@/lib/services/videos";

/** Link overview for guests: project name, permissions and reviewable videos. */
export const GET = handler(async (req, { params }: Ctx<{ token: string }>) => {
  const link = await guestAccess(req, (await params).token);
  const videos = (await listVideos(link.project_id))
    .filter((v) => (link.scope === "video" ? v.id === link.video_id : true))
    .filter((v) => v.current_version_id)
    .map((v) => ({
      id: v.id,
      title: v.title,
      version_count: v.version_count,
      updated_at: v.updated_at,
      thumbnail_url: v.current_version?.status === "ready" ? (v.current_version.thumbnail_url ?? null) : null,
      duration_ms: v.current_version?.duration_ms ?? null,
    }));
  return json({
    link: { project_name: link.project_name, scope: link.scope, can_comment: link.can_comment, expires_at: link.expires_at },
    videos,
  });
});
