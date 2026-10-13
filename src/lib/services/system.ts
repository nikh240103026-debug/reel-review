import "server-only";
import { getDb } from "@/lib/db";
import { env } from "@/lib/env";
import { getStorage } from "@/lib/storage";
import { isFfprobeAvailable } from "./media-probe";
import { isFfmpegAvailable } from "./frames";

export interface SystemStatus {
  database: { driver: "postgres" | "pglite"; ok: boolean; mode: "production" | "local_dev"; error?: string };
  storage: { driver: "s3" | "local"; description: string; ok: boolean | null; error?: string; mode: "production" | "local_dev" };
  ai: { configured: boolean; provider: "gemini" | "claude" | null; model: string | null; effort: string };
  media: { ffprobe: boolean; ffmpeg: boolean };
  security: { appUrl: string; secureCookies: boolean; editorKeyConfigured: boolean; signedUrlTtlSeconds: number };
}

/** Integration status for the settings page. Contains no secrets. */
export async function getSystemStatus(opts: { probeStorage?: boolean } = {}): Promise<SystemStatus> {
  let database: SystemStatus["database"];
  try {
    const db = await getDb();
    await db.query("select 1");
    database = { driver: db.driver, ok: true, mode: db.driver === "pglite" ? "local_dev" : "production" };
  } catch (err) {
    database = { driver: env.databaseUrl ? "postgres" : "pglite", ok: false, mode: env.databaseUrl ? "production" : "local_dev", error: (err as Error).message.slice(0, 200) };
  }

  let storage: SystemStatus["storage"];
  try {
    const s = getStorage();
    storage = { driver: s.kind, description: s.describe(), ok: null, mode: s.kind === "local" ? "local_dev" : "production" };
    if (opts.probeStorage) {
      await s.head(`healthcheck/${Date.now()}.probe`);
      storage.ok = true;
    }
  } catch (err) {
    storage = {
      driver: env.storageDriver,
      description: "Unavailable",
      ok: false,
      error: (err as Error).message.slice(0, 200),
      mode: env.storageDriver === "local" ? "local_dev" : "production",
    };
  }

  let editorKeyConfigured = true;
  try {
    void env.editorAccessKey;
  } catch {
    editorKeyConfigured = false;
  }

  return {
    database,
    storage,
    ai: { configured: env.aiConfigured, provider: env.aiProvider ?? null, model: env.aiConfigured ? env.aiModel : null, effort: env.aiEffort },
    media: { ffprobe: await isFfprobeAvailable(), ffmpeg: await isFfmpegAvailable() },
    security: {
      appUrl: env.appUrl,
      secureCookies: env.secureCookies,
      editorKeyConfigured,
      signedUrlTtlSeconds: env.signedUrlTtlSeconds,
    },
  };
}
