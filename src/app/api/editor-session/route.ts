import { cookies } from "next/headers";
import { z } from "zod";
import { handler, json, parseBody, clientIp, unauthorized } from "@/lib/http";
import { rateLimit, LIMITS } from "@/lib/rate-limit";
import { createSessionToken, verifyAccessKey, EDITOR_COOKIE, EDITOR_SESSION_DAYS } from "@/lib/auth/session-token";
import { env } from "@/lib/env";
import { log } from "@/lib/log";

const Body = z.object({ accessKey: z.string().min(1).max(500) });

/** Exchanges the editor access key for a signed, HttpOnly session cookie. */
export const POST = handler(async (req) => {
  await rateLimit(LIMITS.editorUnlock, clientIp(req));
  const { accessKey } = await parseBody(req, Body);
  // validate configuration loudly before comparing
  void env.appSecret;
  void env.editorAccessKey;
  if (!verifyAccessKey(accessKey)) {
    log.warn("editor.unlock_failed", { ip_hint: clientIp(req).slice(0, 7) });
    throw unauthorized("Incorrect access key");
  }
  const store = await cookies();
  store.set(EDITOR_COOKIE, createSessionToken(), {
    httpOnly: true,
    secure: env.secureCookies,
    sameSite: "lax",
    path: "/",
    maxAge: EDITOR_SESSION_DAYS * 86400,
  });
  log.info("editor.unlocked", {});
  return json({ ok: true });
});

export const DELETE = handler(async () => {
  const store = await cookies();
  store.delete(EDITOR_COOKIE);
  return json({ ok: true });
});
