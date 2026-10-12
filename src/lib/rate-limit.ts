import "server-only";
import { getDb } from "@/lib/db";
import { sha256Hex } from "@/lib/crypto";
import { tooMany } from "@/lib/http";

export interface Limit {
  bucket: string;
  max: number;
  windowSec: number;
}

export const LIMITS = {
  editorUnlock: { bucket: "editor-unlock", max: 10, windowSec: 15 * 60 },
  reviewRead: { bucket: "review-read", max: 240, windowSec: 60 },
  reviewWrite: { bucket: "review-write", max: 30, windowSec: 60 },
  reviewInvalid: { bucket: "review-invalid", max: 30, windowSec: 10 * 60 },
  agentApi: { bucket: "agent-api", max: 600, windowSec: 60 },
  agentRegister: { bucket: "agent-register", max: 10, windowSec: 15 * 60 },
  aiReview: { bucket: "ai-review", max: 20, windowSec: 60 * 60 },
} satisfies Record<string, Limit>;

/**
 * Fixed-window limiter stored in PostgreSQL so it holds across server
 * instances. Identifiers (IPs, tokens) are hashed before storage.
 */
export async function rateLimit(limit: Limit, identifier: string): Promise<void> {
  const db = await getDb();
  const key = `${limit.bucket}:${sha256Hex(identifier).slice(0, 32)}`;
  const [row] = await db.query<{ count: number; reset_in: number }>(
    `insert into rate_limits (key, window_start, count) values ($1, now(), 1)
     on conflict (key) do update set
       count = case when rate_limits.window_start < now() - make_interval(secs => $2::double precision)
                    then 1 else rate_limits.count + 1 end,
       window_start = case when rate_limits.window_start < now() - make_interval(secs => $2::double precision)
                    then now() else rate_limits.window_start end
     returning count,
       greatest(1, ceil(extract(epoch from (window_start + make_interval(secs => $2::double precision) - now()))))::int as reset_in`,
    [key, limit.windowSec],
  );
  if (row && row.count > limit.max) throw tooMany(row.reset_in);
}
