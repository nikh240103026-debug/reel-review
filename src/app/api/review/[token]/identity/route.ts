import { z } from "zod";
import { handler, json, parseBody, type Ctx } from "@/lib/http";
import { guestAccess } from "@/lib/services/guest-access";
import { DisplayName, GuestKey, upsertGuestIdentity } from "@/lib/services/comments";

const Body = z.object({ guestKey: GuestKey, displayName: DisplayName });

/** Records the display name a guest chose. Identification only, not authentication. */
export const POST = handler(async (req, { params }: Ctx<{ token: string }>) => {
  const link = await guestAccess(req, (await params).token, { write: false });
  const { guestKey, displayName } = await parseBody(req, Body);
  await upsertGuestIdentity(link.id, guestKey, displayName);
  return json({ ok: true, displayName });
});
