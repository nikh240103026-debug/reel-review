import "server-only";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { EDITOR_COOKIE, verifySessionToken } from "./session-token";
import { forbidden, unauthorized } from "@/lib/http";
import { env } from "@/lib/env";

/**
 * Defense in depth: proxy.ts already gates editor routes, but every editor
 * route handler and page re-checks the session itself.
 */
export async function isEditor(): Promise<boolean> {
  const store = await cookies();
  return verifySessionToken(store.get(EDITOR_COOKIE)?.value);
}

/** For route handlers. Also enforces same-origin on state-changing requests. */
export async function requireEditor(req: Request): Promise<{ name: string }> {
  if (!(await isEditor())) throw unauthorized("Editor session required");
  if (req.method !== "GET" && req.method !== "HEAD") {
    const origin = req.headers.get("origin");
    if (origin) {
      const reqHost = req.headers.get("x-forwarded-host") ?? req.headers.get("host");
      let originHost: string | null = null;
      try {
        originHost = new URL(origin).host;
      } catch {
        originHost = null;
      }
      if (!originHost || originHost !== reqHost) throw forbidden("Cross-origin request rejected");
    }
  }
  return { name: env.editorDisplayName };
}

/** For server components / pages. */
export async function requireEditorPage(): Promise<{ name: string }> {
  if (!(await isEditor())) redirect("/unlock");
  return { name: env.editorDisplayName };
}
