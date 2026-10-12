/**
 * Structured JSON-line logger. Keys that look like credentials are redacted,
 * and string values that look like bearer tokens are masked.
 */

const SENSITIVE_KEY = /(token|secret|password|authorization|cookie|api[-_]?key|access[-_]?key|signature|sig)$/i;

function redact(value: unknown, depth = 0): unknown {
  if (depth > 6) return "[depth]";
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SENSITIVE_KEY.test(k) ? "[redacted]" : redact(v, depth + 1);
    }
    return out;
  }
  if (typeof value === "string" && /^Bearer\s+/i.test(value)) return "Bearer [redacted]";
  return value;
}

function emit(level: "debug" | "info" | "warn" | "error", event: string, data?: Record<string, unknown>) {
  if (level === "debug" && process.env.LOG_LEVEL !== "debug") return;
  if (process.env.NODE_ENV === "test" && process.env.LOG_IN_TESTS !== "1") return;
  const line = JSON.stringify({ ts: new Date().toISOString(), level, event, ...(redact(data ?? {}) as object) });
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

export const log = {
  debug: (event: string, data?: Record<string, unknown>) => emit("debug", event, data),
  info: (event: string, data?: Record<string, unknown>) => emit("info", event, data),
  warn: (event: string, data?: Record<string, unknown>) => emit("warn", event, data),
  error: (event: string, data?: Record<string, unknown>) => emit("error", event, data),
};

export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
