import { z } from "zod";
import { handler, json, parseBody, assertUuid, type Ctx } from "@/lib/http";
import { requireEditor } from "@/lib/auth/editor";
import { getProject, updateProject } from "@/lib/services/projects";
import { listVideos } from "@/lib/services/videos";
import { listReviewLinks } from "@/lib/services/review-links";
import { listActivity } from "@/lib/services/activity";

export const GET = handler(async (req, { params }: Ctx<{ projectId: string }>) => {
  await requireEditor(req);
  const id = assertUuid((await params).projectId, "project");
  const [project, videos, links, activity] = await Promise.all([
    getProject(id),
    listVideos(id, new URL(req.url).searchParams.get("archived") === "1"),
    listReviewLinks(id),
    listActivity({ projectId: id, limit: 40 }),
  ]);
  return json({ project, videos, links, activity });
});

const Patch = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  description: z.string().trim().max(2000).nullable().optional(),
  status: z.enum(["active", "archived"]).optional(),
});

export const PATCH = handler(async (req, { params }: Ctx<{ projectId: string }>) => {
  const editor = await requireEditor(req);
  const id = assertUuid((await params).projectId, "project");
  await updateProject(id, await parseBody(req, Patch), editor.name);
  return json({ ok: true });
});
