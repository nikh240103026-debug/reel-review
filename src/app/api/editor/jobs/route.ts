import { handler, json } from "@/lib/http";
import { requireEditor } from "@/lib/auth/editor";
import { listJobs } from "@/lib/services/jobs";

export const GET = handler(async (req) => {
  await requireEditor(req);
  const status = new URL(req.url).searchParams.get("status");
  return json({ jobs: await listJobs({ statuses: status ? status.split(",") : undefined }) });
});
