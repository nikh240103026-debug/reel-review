import { notFound } from "next/navigation";
import { HttpError } from "@/lib/http";
import { getJob } from "@/lib/services/jobs";
import { getDb } from "@/lib/db";
import { JobView } from "./job-view";

export const metadata = { title: "Job" };

export default async function JobPage({ params }: PageProps<"/jobs/[jobId]">) {
  const { jobId } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(jobId)) notFound();
  try {
    const data = await getJob(jobId);
    const db = await getDb();
    const [ctx] = await db.query<{ project_id: string }>("select project_id from videos where id = $1", [data.job.video_id]);
    return <JobView initial={data} projectId={ctx!.project_id} />;
  } catch (err) {
    if (err instanceof HttpError && err.status === 404) notFound();
    throw err;
  }
}
