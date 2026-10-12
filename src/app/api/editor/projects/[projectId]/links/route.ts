import { z } from "zod";
import { handler, json, parseBody, assertUuid, type Ctx } from "@/lib/http";
import { requireEditor } from "@/lib/auth/editor";
import { createReviewLink, listReviewLinks } from "@/lib/services/review-links";

export const GET = handler(async (req, { params }: Ctx<{ projectId: string }>) => {
  await requireEditor(req);
  return json({ links: await listReviewLinks(assertUuid((await params).projectId, "project")) });
});

const Create = z.object({
  videoId: z.string().uuid().nullable().optional(),
  label: z.string().trim().max(200).nullable().optional(),
  canComment: z.boolean().default(true),
  expiresAt: z.string().datetime({ offset: true }).nullable().optional(),
});

export const POST = handler(async (req, { params }: Ctx<{ projectId: string }>) => {
  const editor = await requireEditor(req);
  const body = await parseBody(req, Create);
  const link = await createReviewLink(
    {
      projectId: assertUuid((await params).projectId, "project"),
      videoId: body.videoId,
      label: body.label || null,
      canComment: body.canComment,
      expiresAt: body.expiresAt,
    },
    editor.name,
  );
  return json({ link }, 201);
});
