import { handler, json } from "@/lib/http";
import { requireEditor } from "@/lib/auth/editor";
import { getSystemStatus } from "@/lib/services/system";

/** Live integration checks for the settings page. Never returns secrets. */
export const GET = handler(async (req) => {
  await requireEditor(req);
  return json(await getSystemStatus({ probeStorage: true }));
});
