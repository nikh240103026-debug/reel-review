import { z } from "zod";
import { handler, json, parseBody } from "@/lib/http";
import { requireEditor } from "@/lib/auth/editor";
import { createProject, listProjects } from "@/lib/services/projects";

export const GET = handler(async (req) => {
  await requireEditor(req);
  const includeArchived = new URL(req.url).searchParams.get("archived") === "1";
  return json({ projects: await listProjects(includeArchived) });
});

const Create = z.object({
  name: z.string().trim().min(1).max(200),
  description: z.string().trim().max(2000).nullable().optional(),
});

export const POST = handler(async (req) => {
  const editor = await requireEditor(req);
  const body = await parseBody(req, Create);
  const id = await createProject(body, editor.name);
  return json({ id }, 201);
});
