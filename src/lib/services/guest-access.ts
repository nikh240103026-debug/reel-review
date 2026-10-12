import "server-only";
import { getDb } from "@/lib/db";
import { HttpError, clientIp, forbidden, notFound } from "@/lib/http";
import { rateLimit, LIMITS } from "@/lib/rate-limit";
import { assertVideoInScope, resolveReviewToken, type ResolvedLink } from "./review-links";
import { findGuestIdentity } from "./comments";

/**
 * Guest access = a valid review link token. Nothing else (display name,
 * browser storage) is treated as authentication, and a review link can never
 * reach editor-only operations.
 */
export async function guestAccess(req: Request, token: string, opts: { write?: boolean } = {}): Promise<ResolvedLink> {
  const ip = clientIp(req);
  await rateLimit(opts.write ? LIMITS.reviewWrite : LIMITS.reviewRead, `${ip}:${token.slice(0, 12)}`);
  try {
    const link = await resolveReviewToken(token);
    if (opts.write && !link.can_comment) throw forbidden("This review link is view-only.");
    return link;
  } catch (err) {
    if (err instanceof HttpError && err.status === 404) {
      // throttle token guessing per client
      await rateLimit(LIMITS.reviewInvalid, ip);
    }
    throw err;
  }
}

export async function guestVideoAccess(req: Request, token: string, videoId: string, opts: { write?: boolean } = {}) {
  const link = await guestAccess(req, token, opts);
  await assertVideoInScope(link, videoId);
  const guestIdentityId = await findGuestIdentity(link.id, req.headers.get("x-guest-key"));
  return { link, guestIdentityId };
}

/** Guests may only read comments on ready versions of an in-scope video. */
export async function assertGuestVersion(videoId: string, versionId: string) {
  const db = await getDb();
  const [v] = await db.query<{ video_id: string; status: string }>("select video_id, status from video_versions where id = $1", [versionId]);
  if (!v || v.video_id !== videoId || v.status !== "ready") throw notFound("Version not found");
}
