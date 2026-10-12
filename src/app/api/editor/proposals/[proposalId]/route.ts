import { z } from "zod";
import { handler, json, parseBody, assertUuid, badRequest, type Ctx } from "@/lib/http";
import { requireEditor } from "@/lib/auth/editor";
import {
  approveProposal,
  changeAdapter,
  createRevision,
  getProposal,
  rejectProposal,
} from "@/lib/services/proposals";
import { queueJob } from "@/lib/services/jobs";

export const GET = handler(async (req, { params }: Ctx<{ proposalId: string }>) => {
  await requireEditor(req);
  return json(await getProposal(assertUuid((await params).proposalId, "proposal")));
});

const Action = z.discriminatedUnion("action", [
  z.object({ action: z.literal("approve"), contentHash: z.string().regex(/^[0-9a-f]{64}$/) }),
  z.object({ action: z.literal("reject"), reason: z.string().trim().max(1000).nullable().optional() }),
  z.object({ action: z.literal("revise") }),
  z.object({ action: z.literal("set_adapter"), adapter: z.string().min(1).max(40) }),
  z.object({ action: z.literal("queue"), deviceId: z.string().uuid().nullable().optional() }),
]);

/** Proposal lifecycle actions. Approval is bound to the exact content hash the editor reviewed. */
export const POST = handler(async (req, { params }: Ctx<{ proposalId: string }>) => {
  const editor = await requireEditor(req);
  const id = assertUuid((await params).proposalId, "proposal");
  const body = await parseBody(req, Action);
  switch (body.action) {
    case "approve":
      return json(await approveProposal(id, body.contentHash, editor.name));
    case "reject":
      await rejectProposal(id, body.reason ?? null, editor.name);
      return json({ ok: true });
    case "revise":
      return json({ proposalId: await createRevision(id, editor.name) }, 201);
    case "set_adapter":
      return json(await changeAdapter(id, body.adapter, editor.name));
    case "queue":
      return json({ jobId: await queueJob(id, { deviceId: body.deviceId ?? null }, editor.name) }, 201);
    default:
      throw badRequest("Unknown action");
  }
});
