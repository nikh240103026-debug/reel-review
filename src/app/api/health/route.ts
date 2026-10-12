import { handler, json } from "@/lib/http";
import { getDb } from "@/lib/db";

/** Liveness/readiness probe. Reveals no configuration details. */
export const GET = handler(async () => {
  const db = await getDb();
  await db.query("select 1");
  return json({ ok: true });
});
