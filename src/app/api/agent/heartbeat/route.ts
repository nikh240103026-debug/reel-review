import { z } from "zod";
import { handler, json, parseBody } from "@/lib/http";
import { requireAgent } from "@/lib/auth/agent";
import { updateDeviceCapabilities } from "@/lib/services/devices";

const Body = z.object({
  agentVersion: z.string().max(40).optional(),
  adapters: z.array(z.string().max(40)).max(20).optional(),
  capabilities: z.record(z.string(), z.unknown()).optional(),
});

export const POST = handler(async (req) => {
  const device = await requireAgent(req);
  const b = await parseBody(req, Body);
  await updateDeviceCapabilities(device.id, b);
  return json({ ok: true, deviceId: device.id, name: device.name });
});
