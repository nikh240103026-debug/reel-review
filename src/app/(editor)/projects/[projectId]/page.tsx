import { notFound } from "next/navigation";
import { getProject } from "@/lib/services/projects";
import { listVideos } from "@/lib/services/videos";
import { listReviewLinks } from "@/lib/services/review-links";
import { listActivity } from "@/lib/services/activity";
import { HttpError } from "@/lib/http";
import { ProjectView } from "./project-view";

export const metadata = { title: "Project" };

export default async function ProjectPage({ params }: PageProps<"/projects/[projectId]">) {
  const { projectId } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(projectId)) notFound();
  try {
    const [project, videos, links, activity] = await Promise.all([
      getProject(projectId),
      listVideos(projectId, true),
      listReviewLinks(projectId),
      listActivity({ projectId, limit: 40 }),
    ]);
    return <ProjectView project={project} videos={videos} links={links} activity={activity} />;
  } catch (err) {
    if (err instanceof HttpError && err.status === 404) notFound();
    throw err;
  }
}
