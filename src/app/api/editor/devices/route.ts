import { z } from "zod";
import { handler, json, parseBody } from "@/lib/http";
import { requireEditor } from "@/lib/auth/editor";
import { createRegistration, listDevices } from "@/lib/services/devices";

export const GET = handler(async (req) => {
  await requireEditor(req);
  return json({ devices: await listDevices() });
});

const Create = z.object({ name: z.string().trim().min(1).max(100) });

/** Creates a pending device and returns a one-time registration code (shown once). */
export const POST = handler(async (req) => {
  const editor = await requireEditor(req);
  const { name } = await parseBody(req, Create);
  return json(await createRegistration(name, editor.name), 201);
});
