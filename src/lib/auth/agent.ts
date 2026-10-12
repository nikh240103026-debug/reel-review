import "server-only";
import { rateLimit, LIMITS } from "@/lib/rate-limit";
import { clientIp } from "@/lib/http";
import { authenticateDevice, type AuthedDevice } from "@/lib/services/devices";

/** Authenticates the local editing agent by its device token (Bearer). */
export async function requireAgent(req: Request): Promise<AuthedDevice> {
  await rateLimit(LIMITS.agentApi, `agent:${clientIp(req)}`);
  return authenticateDevice(req);
}
