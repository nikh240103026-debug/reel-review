import { handler, json } from "@/lib/http";
import { requireEditor } from "@/lib/auth/editor";
import { listActivity } from "@/lib/services/activity";

export const GET = handler(async (req) => {
  await requireEditor(req);
  return json({ activity: await listActivity({ limit: 50 }) });
});
