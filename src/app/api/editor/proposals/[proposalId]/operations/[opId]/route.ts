import { z } from "zod";
import { handler, json, parseBody, assertUuid, badRequest, type Ctx } from "@/lib/http";
import { requireEditor } from "@/lib/auth/editor";
import { decideOperation, editOperation, postClarification } from "@/lib/services/proposals";

const Edit = z.object({
  op_type: z.string().max(40).optional(),
  start_ms: z.number().int().min(0).optional(),
  end_ms: z.number().int().min(0).nullable().optional(),
  params: z.record(z.string(), z.unknown()).optional(),
  clarified: z.boolean().optional(),
});

/** Editing any field resets this operation's approval (material change). */
export const PATCH = handler(async (req, { params }: Ctx<{ proposalId: string; opId: string }>) => {
  const editor = await requireEditor(req);
  const p = await params;
  const body = await parseBody(req, Edit);
  if (body.params && JSON.stringify(body.params).length > 10_000) throw badRequest("Parameters are too large");
  return json(await editOperation(assertUuid(p.proposalId, "proposal"), assertUuid(p.opId, "operation"), body, editor.name));
});

const Action = z.discriminatedUnion("action", [
  z.object({ action: z.literal("decide"), decision: z.enum(["approved", "rejected", "pending"]) }),
  z.object({ action: z.literal("ask_client") }),
]);

export const POST = handler(async (req, { params }: Ctx<{ proposalId: string; opId: string }>) => {
  const editor = await requireEditor(req);
  const p = await params;
  const proposalId = assertUuid(p.proposalId, "proposal");
  const opId = assertUuid(p.opId, "operation");
  const body = await parseBody(req, Action);
  if (body.action === "decide") return json(await decideOperation(proposalId, opId, body.decision, editor.name));
  return json({ commentId: await postClarification(proposalId, opId, editor.name) }, 201);
});
