import { Suspense } from "react";
import { HttpError } from "@/lib/http";
import { assertVideoInScope } from "@/lib/services/review-links";
import { ReviewWorkspace } from "@/components/review/review-workspace";
import { LinkError, resolveForPage } from "../../link-error";

export const metadata = { title: "Review" };

export default async function GuestVideoPage({ params }: PageProps<"/r/[token]/v/[videoId]">) {
  const { token, videoId } = await params;
  const res = await resolveForPage(token);
  if ("error" in res) return <LinkError error={res.error} />;
  try {
    if (!/^[0-9a-f-]{36}$/i.test(videoId)) throw new HttpError(404, "Video not found");
    await assertVideoInScope(res.link, videoId);
  } catch (err) {
    if (err instanceof HttpError) return <LinkError error={err} />;
    throw err;
  }
  return (
    <Suspense>
      <ReviewWorkspace
        mode="guest"
        apiBase={`/api/review/${token}/videos/${videoId}`}
        identityBase={`/api/review/${token}/identity`}
        backHref={res.link.scope === "project" ? `/r/${token}` : undefined}
        backLabel="All videos"
      />
    </Suspense>
  );
}
