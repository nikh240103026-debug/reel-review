import { z } from "zod";
import { handler, json, parseBody, assertUuid, type Ctx } from "@/lib/http";
import { requireEditor } from "@/lib/auth/editor";
import { cancelJob, finishManualWithoutRender, getJob, retryJob, setManualTask } from "@/lib/services/jobs";

export const GET = handler(async (req, { params }: Ctx<{ jobId: string }>) => {
  await requireEditor(req);
  return json(await getJob(assertUuid((await params).jobId, "job")));
});

const Action = z.discriminatedUnion("action", [
  z.object({ action: z.literal("cancel") }),
  z.object({ action: z.literal("retry") }),
  z.object({ action: z.literal("finish_without_render") }),
  z.object({ action: z.literal("task"), opId: z.string().uuid(), done: z.boolean() }),
]);

export const POST = handler(async (req, { params }: Ctx<{ jobId: string }>) => {
  const editor = await requireEditor(req);
  const id = assertUuid((await params).jobId, "job");
  const body = await parseBody(req, Action);
  if (body.action === "cancel") await cancelJob(id, editor.name);
  else if (body.action === "retry") await retryJob(id, editor.name);
  else if (body.action === "finish_without_render") await finishManualWithoutRender(id, editor.name);
  else await setManualTask(id, body.opId, body.done, editor.name);
  return json(await getJob(id));
});
