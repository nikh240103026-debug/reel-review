import { PageHeader } from "@/components/app-shell";
import { listJobs } from "@/lib/services/jobs";
import { JobsTable } from "./jobs-table";

export const metadata = { title: "Jobs" };

export default async function JobsPage() {
  const jobs = await listJobs({ limit: 100 });
  return (
    <>
      <PageHeader title="Editing jobs" description="Approved proposals executed by your local editing agents. Live status, retries and logs." />
      <div className="px-4 py-6 sm:px-6">
        <JobsTable initial={jobs} />
      </div>
    </>
  );
}
