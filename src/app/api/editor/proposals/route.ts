import { z } from "zod";
import { handler, json, parseQuery } from "@/lib/http";
import { requireEditor } from "@/lib/auth/editor";
import { listProposals } from "@/lib/services/proposals";
import type { ProposalStatus } from "@/shared/dto";

const Query = z.object({
  videoId: z.string().uuid().optional(),
  status: z.string().max(200).optional(),
});

export const GET = handler(async (req) => {
  await requireEditor(req);
  const q = parseQuery(req, Query);
  const statuses = q.status ? (q.status.split(",") as ProposalStatus[]) : undefined;
  return json({ proposals: await listProposals({ videoId: q.videoId, statuses }) });
});
