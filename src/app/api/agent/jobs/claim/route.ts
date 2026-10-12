import { handler, json } from "@/lib/http";
import { requireAgent } from "@/lib/auth/agent";
import { claimJob } from "@/lib/services/jobs";

/** Leases the next approved job this device can run (revalidated server-side first). */
export const POST = handler(async (req) => {
  const device = await requireAgent(req);
  const job = await claimJob(device);
  return json({ job });
});
