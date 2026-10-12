import { z } from "zod";
import { handler, json, parseBody, assertUuid, type Ctx } from "@/lib/http";
import { requireEditor } from "@/lib/auth/editor";
import { renameDevice, revokeDevice } from "@/lib/services/devices";

const Patch = z.object({ name: z.string().trim().min(1).max(100) });

export const PATCH = handler(async (req, { params }: Ctx<{ deviceId: string }>) => {
  await requireEditor(req);
  await renameDevice(assertUuid((await params).deviceId, "device"), (await parseBody(req, Patch)).name);
  return json({ ok: true });
});

/** Revokes the device token immediately; running jobs return to the queue. */
export const DELETE = handler(async (req, { params }: Ctx<{ deviceId: string }>) => {
  const editor = await requireEditor(req);
  await revokeDevice(assertUuid((await params).deviceId, "device"), editor.name);
  return json({ ok: true });
});
