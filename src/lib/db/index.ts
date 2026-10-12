import "server-only";
import fs from "node:fs";
import path from "node:path";
import { env } from "@/lib/env";
import { log } from "@/lib/log";

/**
 * Minimal database abstraction with two drivers:
 *  - `postgres` (postgres.js) for Supabase / any PostgreSQL via DATABASE_URL
 *  - `pglite` (PostgreSQL compiled to WASM) for local development mode
 * Both run the exact same SQL migrations. Rows are normalised so bigint
 * columns become numbers and timestamps become ISO strings.
 */

export type Row = Record<string, unknown>;

export interface Queryable {
  query<T = Row>(text: string, params?: unknown[]): Promise<T[]>;
}

export interface Db extends Queryable {
  driver: "postgres" | "pglite";
  tx<T>(fn: (q: Queryable) => Promise<T>): Promise<T>;
  /** Runs a multi-statement SQL script and the follow-up query in one transaction. */
  runScript(script: string, after: { text: string; params: unknown[] }): Promise<void>;
  close(): Promise<void>;
}

function normalizeValue(v: unknown): unknown {
  if (v instanceof Date) return v.toISOString();
  if (typeof v === "bigint") return Number(v);
  return v;
}

function normalizeRows<T>(rows: Row[]): T[] {
  for (const row of rows) {
    for (const k of Object.keys(row)) row[k] = normalizeValue(row[k]);
  }
  return rows as T[];
}

async function createPostgresDb(url: string): Promise<Db> {
  const { default: postgres } = await import("postgres");
  const sql = postgres(url, {
    max: Number(process.env.DATABASE_POOL_MAX ?? 5),
    prepare: false, // required for Supabase's transaction-mode pooler
    idle_timeout: 20,
    types: {
      bigint: {
        to: 20,
        from: [20],
        serialize: (x: number) => String(x),
        parse: (x: string) => Number(x),
      },
    },
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const make = (s: { unsafe: (text: string, params?: any[]) => PromiseLike<unknown> }): Queryable => ({
    async query<T>(text: string, params: unknown[] = []) {
      const rows = (await s.unsafe(text, params)) as Row[];
      return normalizeRows<T>([...rows]);
    },
  });
  const base = make(sql);
  return {
    driver: "postgres",
    query: base.query,
    async tx<T>(fn: (q: Queryable) => Promise<T>) {
      return (await sql.begin((t) => fn(make(t)))) as T;
    },
    async runScript(script, after) {
      await sql.begin(async (t) => {
        await t.unsafe(script); // no params => simple protocol, multi-statement allowed
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await t.unsafe(after.text, after.params as any[]);
      });
    },
    async close() {
      await sql.end({ timeout: 5 });
    },
  };
}

async function createPgliteDb(dataDir: string): Promise<Db> {
  const { PGlite } = await import("@electric-sql/pglite");
  const inMemory = dataDir === "memory" || dataDir.startsWith("memory://");
  if (!inMemory) fs.mkdirSync(dataDir, { recursive: true });
  const pg = inMemory ? new PGlite() : new PGlite(dataDir);
  await pg.waitReady;
  const make = (q: { query: typeof pg.query }): Queryable => ({
    async query<T>(text: string, params: unknown[] = []) {
      const res = await q.query<Row>(text, params);
      return normalizeRows<T>(res.rows);
    },
  });
  const base = make(pg);
  return {
    driver: "pglite",
    query: base.query,
    async tx<T>(fn: (q: Queryable) => Promise<T>) {
      return pg.transaction((t) => fn(make(t)));
    },
    async runScript(script, after) {
      await pg.transaction(async (t) => {
        await t.exec(script);
        await t.query(after.text, after.params);
      });
    },
    async close() {
      await pg.close();
    },
  };
}

export function migrationsDir(): string {
  return path.join(process.cwd(), "supabase", "migrations");
}

/** Applies any pending migrations in filename order. Idempotent. */
export async function runMigrations(db: Db): Promise<string[]> {
  await db.query(`create table if not exists schema_migrations (
    name text primary key, applied_at timestamptz not null default now())`);
  const applied = new Set(
    (await db.query<{ name: string }>("select name from schema_migrations")).map((r) => r.name),
  );
  const files = fs
    .readdirSync(migrationsDir())
    .filter((f) => f.endsWith(".sql"))
    .sort();
  const ran: string[] = [];
  for (const file of files) {
    if (applied.has(file)) continue;
    const sqlText = fs.readFileSync(path.join(migrationsDir(), file), "utf8");
    await db.runScript(sqlText, { text: "insert into schema_migrations (name) values ($1)", params: [file] });
    ran.push(file);
  }
  return ran;
}

declare global {
  var __reelreviewDb: Promise<Db> | undefined;
}

export async function openDb(): Promise<Db> {
  const url = env.databaseUrl;
  if (url) return createPostgresDb(url);
  return createPgliteDb(env.pgliteDir);
}

/** Process-wide singleton. PGlite auto-migrates; Postgres requires `npm run db:migrate`. */
export function getDb(): Promise<Db> {
  if (!globalThis.__reelreviewDb) {
    globalThis.__reelreviewDb = (async () => {
      const db = await openDb();
      if (db.driver === "pglite") {
        const ran = await runMigrations(db);
        if (ran.length) log.info("db.migrated", { driver: "pglite", migrations: ran });
      }
      return db;
    })().catch((err) => {
      globalThis.__reelreviewDb = undefined;
      throw err;
    });
  }
  return globalThis.__reelreviewDb;
}

/** Test helper: replace the singleton (e.g. with an in-memory PGlite). */
export function setDbForTests(db: Promise<Db> | undefined) {
  globalThis.__reelreviewDb = db;
}
