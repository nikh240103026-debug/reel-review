import { NextResponse, type NextRequest } from "next/server";
import { EDITOR_COOKIE, verifySessionToken } from "@/lib/auth/session-token";

/**
 * Editor gate. Everything is editor-only EXCEPT:
 *  - /r/*               guest review pages (token-validated server side)
 *  - /api/review/*      guest review API (token-validated per request)
 *  - /api/agent/*       local editing agent API (device-token authenticated)
 *  - /api/storage/local signed local-storage URLs (HMAC-validated); excluded
 *                       entirely so large uploads are not buffered by proxy
 *  - /unlock, /api/editor-session  the editor access-key exchange
 * Route handlers re-check authorization themselves; this is the first layer.
 */
export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const ok = verifySessionToken(request.cookies.get(EDITOR_COOKIE)?.value);
  if (ok) return NextResponse.next();

  if (pathname.startsWith("/api/")) {
    return NextResponse.json({ error: "Editor session required", code: "unauthorized" }, { status: 401 });
  }
  const url = request.nextUrl.clone();
  url.pathname = "/unlock";
  url.search = "";
  if (pathname !== "/") url.searchParams.set("next", pathname);
  return NextResponse.redirect(url);
}

export const config = {
  matcher: [
    "/((?!r/|api/review/|api/agent/|api/storage/|api/editor-session|api/health|unlock|_next/static|_next/image|favicon.ico).*)",
  ],
};
