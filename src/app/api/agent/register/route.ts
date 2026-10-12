import { z } from "zod";
import { handler, json, parseBody, clientIp } from "@/lib/http";
import { rateLimit, LIMITS } from "@/lib/rate-limit";
import { registerDevice } from "@/lib/services/devices";

const Body = z.object({
  code: z.string().trim().min(8).max(32),
  platform: z.string().max(100).optional(),
  agentVersion: z.string().max(40).optional(),
  adapters: z.array(z.string().max(40)).max(20).optional(),
  capabilities: z.record(z.string(), z.unknown()).optional(),
});

/** Exchanges a one-time registration code for a long-lived device token. */
export const POST = handler(async (req) => {
  await rateLimit(LIMITS.agentRegister, clientIp(req));
  const b = await parseBody(req, Body);
  const res = await registerDevice(b.code, b);
  return json({ deviceId: res.deviceId, name: res.name, token: res.token }, 201);
});
