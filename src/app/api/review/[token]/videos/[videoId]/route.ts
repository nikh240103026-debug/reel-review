import { handler, json, assertUuid, type Ctx } from "@/lib/http";
import { guestVideoAccess } from "@/lib/services/guest-access";
import { buildReviewView } from "@/lib/services/review-view";

export const GET = handler(async (req, { params }: Ctx<{ token: string; videoId: string }>) => {
  const p = await params;
  const videoId = assertUuid(p.videoId, "video");
  const { link } = await guestVideoAccess(req, p.token, videoId);
  return json(await buildReviewView(videoId, { isEditor: false, canComment: link.can_comment }));
});
