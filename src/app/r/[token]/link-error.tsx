import { headers } from "next/headers";
import { AlertTriangle, Clapperboard } from "lucide-react";
import { HttpError } from "@/lib/http";
import { guestAccess } from "@/lib/services/guest-access";
import type { ResolvedLink } from "@/lib/services/review-links";

/** Validates a review token for a server-rendered guest page (same checks as the API). */
export async function resolveForPage(token: string): Promise<{ link: ResolvedLink } | { error: HttpError }> {
  const h = await headers();
  const req = new Request("http://internal/r", { headers: h });
  try {
    return { link: await guestAccess(req, token) };
  } catch (err) {
    if (err instanceof HttpError) return { error: err };
    throw err;
  }
}

export function LinkError({ error }: { error: HttpError }) {
  const title =
    error.status === 410 ? "This review link is no longer active" : error.status === 429 ? "Too many requests" : "Review link not found";
  return (
    <div className="flex min-h-screen flex-col items-center justify-center px-6 text-center">
      <div className="mb-6 flex items-center gap-2 text-muted-foreground">
        <Clapperboard className="size-4" /> <span className="text-sm">ReelReview</span>
      </div>
      <AlertTriangle className="mb-3 size-6 text-warning" />
      <h1 className="text-base font-medium">{title}</h1>
      <p className="mt-1 max-w-sm text-sm text-muted-foreground">{error.message}</p>
    </div>
  );
}
