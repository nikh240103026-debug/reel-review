import { z } from "zod";
import { handler, json, parseBody, assertUuid, type Ctx } from "@/lib/http";
import { requireEditor } from "@/lib/auth/editor";
import { getReviewLink, updateReviewLink } from "@/lib/services/review-links";

const Patch = z.object({
  revoke: z.boolean().optional(),
  canComment: z.boolean().optional(),
  expiresAt: z.string().datetime({ offset: true }).nullable().optional(),
  label: z.string().trim().max(200).nullable().optional(),
});

export const PATCH = handler(async (req, { params }: Ctx<{ linkId: string }>) => {
  const editor = await requireEditor(req);
  const id = assertUuid((await params).linkId, "link");
  await updateReviewLink(id, await parseBody(req, Patch), editor.name);
  return json({ link: await getReviewLink(id) });
});
