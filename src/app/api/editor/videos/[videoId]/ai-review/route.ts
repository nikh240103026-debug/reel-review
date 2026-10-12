import { z } from "zod";
import { handler, json, parseBody, assertUuid, clientIp, type Ctx } from "@/lib/http";
import { requireEditor } from "@/lib/auth/editor";
import { rateLimit, LIMITS } from "@/lib/rate-limit";
import { generateProposal } from "@/lib/services/proposals";

const Body = z.object({
  versionId: z.string().uuid(),
  adapter: z.string().min(1).max(40),
  mode: z.enum(["claude", "offline"]),
});

/** Analyzes unresolved comments on one version and creates a proposal awaiting approval. Executes nothing. */
export const POST = handler(async (req, { params }: Ctx<{ videoId: string }>) => {
  const editor = await requireEditor(req);
  await rateLimit(LIMITS.aiReview, `editor:${clientIp(req)}`);
  const b = await parseBody(req, Body);
  const proposalId = await generateProposal(assertUuid((await params).videoId, "video"), b, editor.name);
  return json({ proposalId }, 201);
});
