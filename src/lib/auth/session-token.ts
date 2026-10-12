import crypto from "node:crypto";

/**
 * Editor session tokens: base64url(JSON payload) + "." + HMAC-SHA256.
 * The signing key is derived from APP_SECRET *and* EDITOR_ACCESS_KEY, so
 * rotating the access key immediately invalidates every editor session.
 * Kept dependency-free so it can run inside proxy.ts.
 */

export const EDITOR_COOKIE = "rr_editor";
export const EDITOR_SESSION_DAYS = 14;

interface Payload {
  iat: number;
  exp: number;
  sid: string;
}

function signingKey(): string | null {
  const secret = process.env.APP_SECRET?.trim();
  const access = process.env.EDITOR_ACCESS_KEY?.trim();
  if (!secret || secret.length < 32 || !access || access.length < 16) return null;
  const accessDigest = crypto.createHash("sha256").update(access).digest("hex");
  return `editor-session:${secret}:${accessDigest}`;
}

function sign(data: string, key: string): string {
  return crypto.createHmac("sha256", key).update(data).digest("base64url");
}

export function createSessionToken(now = Date.now()): string {
  const key = signingKey();
  if (!key) throw new Error("APP_SECRET / EDITOR_ACCESS_KEY are not configured");
  const payload: Payload = {
    iat: Math.floor(now / 1000),
    exp: Math.floor(now / 1000) + EDITOR_SESSION_DAYS * 86400,
    sid: crypto.randomBytes(9).toString("base64url"),
  };
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${body}.${sign(body, key)}`;
}

export function verifySessionToken(token: string | undefined | null, now = Date.now()): boolean {
  if (!token) return false;
  const key = signingKey();
  if (!key) return false;
  const [body, sig] = token.split(".");
  if (!body || !sig) return false;
  const expected = Buffer.from(sign(body, key));
  const given = Buffer.from(sig);
  if (expected.length !== given.length || !crypto.timingSafeEqual(expected, given)) return false;
  try {
    const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as Payload;
    return typeof payload.exp === "number" && payload.exp * 1000 > now;
  } catch {
    return false;
  }
}

export function verifyAccessKey(candidate: string): boolean {
  const access = process.env.EDITOR_ACCESS_KEY?.trim();
  if (!access || access.length < 16) return false;
  const a = crypto.createHash("sha256").update(candidate).digest();
  const b = crypto.createHash("sha256").update(access).digest();
  return crypto.timingSafeEqual(a, b);
}
