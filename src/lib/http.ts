import "server-only";
import { z } from "zod";
import { ConfigError } from "@/lib/env";
import { log, errorMessage } from "@/lib/log";

export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
    public code = "error",
    public details?: unknown,
  ) {
    super(message);
  }
}

export const badRequest = (msg: string, details?: unknown) => new HttpError(400, msg, "bad_request", details);
export const unauthorized = (msg = "Not authorized") => new HttpError(401, msg, "unauthorized");
export const forbidden = (msg = "Forbidden") => new HttpError(403, msg, "forbidden");
export const notFound = (msg = "Not found") => new HttpError(404, msg, "not_found");
export const conflict = (msg: string, details?: unknown) => new HttpError(409, msg, "conflict", details);
export const gone = (msg: string) => new HttpError(410, msg, "gone");
export const tooMany = (retryAfterSec: number) =>
  new HttpError(429, "Too many requests. Please slow down.", "rate_limited", { retryAfterSec });

export function json(data: unknown, init?: number | ResponseInit): Response {
  const opts = typeof init === "number" ? { status: init } : init;
  return Response.json(data, {
    ...opts,
    headers: { "Cache-Control": "no-store", ...(opts?.headers ?? {}) },
  });
}

export async function parseBody<T extends z.ZodType>(req: Request, schema: T): Promise<z.infer<T>> {
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    throw badRequest("Request body must be valid JSON");
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    throw badRequest("Invalid request", z.flattenError(parsed.error));
  }
  return parsed.data;
}

export function parseQuery<T extends z.ZodType>(req: Request, schema: T): z.infer<T> {
  const url = new URL(req.url);
  const parsed = schema.safeParse(Object.fromEntries(url.searchParams));
  if (!parsed.success) throw badRequest("Invalid query", z.flattenError(parsed.error));
  return parsed.data;
}

export const uuid = z.string().uuid();

export function assertUuid(value: string, what = "id"): string {
  if (!uuid.safeParse(value).success) throw notFound(`Unknown ${what}`);
  return value;
}

/** Wraps a route handler with uniform error handling and structured logs. */
export function handler<Ctx>(fn: (req: Request, ctx: Ctx) => Promise<Response>) {
  return async (req: Request, ctx: Ctx): Promise<Response> => {
    try {
      return await fn(req, ctx);
    } catch (err) {
      if (err instanceof HttpError) {
        const headers: Record<string, string> = {};
        if (err.status === 429 && err.details && typeof err.details === "object") {
          headers["Retry-After"] = String((err.details as { retryAfterSec: number }).retryAfterSec);
        }
        return json({ error: err.message, code: err.code, details: err.details }, { status: err.status, headers });
      }
      if (err instanceof ConfigError) {
        log.error("config.error", { message: err.message });
        return json({ error: err.message, code: "config_error" }, 500);
      }
      const pgCode = (err as { code?: string })?.code;
      if (pgCode === "23505") {
        return json({ error: "Conflicting request (already exists).", code: "conflict" }, 409);
      }
      if (pgCode === "P0001") {
        // raised by an integrity trigger
        return json({ error: errorMessage(err), code: "integrity_violation" }, 409);
      }
      log.error("request.failed", { method: req.method, path: new URL(req.url).pathname, error: errorMessage(err) });
      return json({ error: "Internal server error", code: "internal" }, 500);
    }
  };
}

export function clientIp(req: Request): string {
  // Only the first hop is used. Deploy behind a proxy that sets X-Forwarded-For.
  const xff = req.headers.get("x-forwarded-for");
  if (xff) return xff.split(",")[0]!.trim();
  return req.headers.get("x-real-ip") ?? "local";
}

export type Ctx<P = Record<string, string>> = { params: Promise<P> };
