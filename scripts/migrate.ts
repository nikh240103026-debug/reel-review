// Applies pending SQL migrations to DATABASE_URL (Supabase/PostgreSQL) or, when
// unset, to the local PGlite database. Usage: npm run db:migrate
import { loadEnvConfig } from "@next/env";
import { openDb, runMigrations } from "../src/lib/db";

loadEnvConfig(process.cwd());

async function main() {
  const db = await openDb();
  console.log(`Migrating ${db.driver === "postgres" ? "PostgreSQL (DATABASE_URL)" : "local PGlite database"}…`);
  const ran = await runMigrations(db);
  console.log(ran.length ? `Applied: ${ran.join(", ")}` : "Already up to date.");
  await db.close();
}

main().catch((err) => {
  console.error("Migration failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
