import "server-only";
import path from "node:path";

/**
 * Central, validated access to configuration. Secrets are read lazily so that
 * `next build` does not require production credentials.
 */

function str(name: string): string | undefined {
  const v = process.env[name];
  return v === undefined || v.trim() === "" ? undefined : v.trim();
}

function int(name: string, fallback: number): number {
  const v = str(name);
  if (!v) return fallback;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : fallback;
}

function isVercelProduction(): boolean {
  return process.env.VERCEL === "1" && process.env.NODE_ENV === "production";
}

export class ConfigError extends Error {}

export const env = {
  get appSecret(): string {
    const v = str("APP_SECRET");
    if (!v || v.length < 32) {
      throw new ConfigError("APP_SECRET must be set to at least 32 random characters (run `npm run setup`).");
    }
    return v;
  },
  get editorAccessKey(): string {
    const v = str("EDITOR_ACCESS_KEY");
    if (!v || v.length < 16) {
      throw new ConfigError("EDITOR_ACCESS_KEY must be set to at least 16 characters (run `npm run setup`).");
    }
    return v;
  },
  get editorDisplayName(): string {
    return (str("EDITOR_DISPLAY_NAME") ?? "Editor").slice(0, 80);
  },
  get appUrl(): string {
    const configured = str("APP_URL");
    if (!configured && process.env.NODE_ENV === "production") {
      throw new ConfigError("APP_URL must be set to the public app URL in production.");
    }
    if (isVercelProduction() && !configured?.startsWith("https://")) {
      throw new ConfigError("APP_URL must be the public HTTPS URL in Vercel production.");
    }
    return (configured ?? "http://localhost:3000").replace(/\/+$/, "");
  },
  get secureCookies(): boolean {
    return this.appUrl.startsWith("https://");
  },

  // Database
  get databaseUrl(): string | undefined {
    const url = str("DATABASE_URL");
    if (isVercelProduction() && !url) {
      throw new ConfigError("DATABASE_URL must be configured for Vercel production; local PGlite storage is not durable there.");
    }
    return url;
  },
  get pgliteDir(): string {
    return str("PGLITE_DATA_DIR") ?? path.join(process.cwd(), ".data", "pglite");
  },

  // Storage
  get storageDriver(): "s3" | "local" {
    const explicit = str("STORAGE_DRIVER");
    const s3 = this.s3;
    if (isVercelProduction()) {
      if (explicit === "local") {
        throw new ConfigError("Vercel production requires S3-compatible object storage; local filesystem storage is not durable.");
      }
      if (!s3.bucket || !s3.accessKeyId || !s3.secretAccessKey || !s3.endpoint) {
        throw new ConfigError("Configure S3_ENDPOINT (or R2_ACCOUNT_ID), S3_BUCKET, S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY for Vercel production.");
      }
      return "s3";
    }
    if (explicit === "s3" || explicit === "local") return explicit;
    return s3.bucket && s3.accessKeyId && s3.secretAccessKey ? "s3" : "local";
  },
  get s3() {
    const accountId = str("R2_ACCOUNT_ID");
    return {
      endpoint: str("S3_ENDPOINT") ?? (accountId ? `https://${accountId}.r2.cloudflarestorage.com` : undefined),
      region: str("S3_REGION") ?? "auto",
      bucket: str("S3_BUCKET"),
      accessKeyId: str("S3_ACCESS_KEY_ID"),
      secretAccessKey: str("S3_SECRET_ACCESS_KEY"),
      forcePathStyle: str("S3_FORCE_PATH_STYLE") === "true",
    };
  },
  get localStorageDir(): string {
    return str("LOCAL_STORAGE_DIR") ?? path.join(process.cwd(), ".data", "storage");
  },
  get signedUrlTtlSeconds(): number {
    return Math.min(Math.max(int("SIGNED_URL_TTL_SECONDS", 3600), 60), 7 * 24 * 3600);
  },
  get maxUploadBytes(): number {
    const maxUploadMb = str("MAX_UPLOAD_MB");
    if (maxUploadMb) {
      const parsed = Number(maxUploadMb);
      if (!Number.isFinite(parsed) || parsed <= 0) {
        throw new ConfigError("MAX_UPLOAD_MB must be a positive number.");
      }
      return Math.floor(parsed * 1024 * 1024);
    }
    if (this.s3.endpoint && new URL(this.s3.endpoint).hostname.endsWith(".supabase.co")) {
      return 50 * 1024 * 1024;
    }
    return int("MAX_UPLOAD_GB", 20) * 1024 * 1024 * 1024;
  },

  // AI
  get anthropicConfigured(): boolean {
    return Boolean(str("ANTHROPIC_API_KEY") || str("ANTHROPIC_AUTH_TOKEN"));
  },
  get anthropicModel(): string {
    return str("ANTHROPIC_MODEL") ?? "claude-opus-5-5";
  },
  get aiEffort(): "low" | "medium" | "high" | "xhigh" | "max" {
    const v = str("AI_EFFORT");
    return v === "low" || v === "medium" || v === "high" || v === "xhigh" || v === "max" ? v : "high";
  },

  // Media tooling (optional, server side)
  get ffprobePath(): string | undefined {
    return str("FFPROBE_PATH");
  },

  // Agent jobs
  get jobLeaseSeconds(): number {
    return Math.min(Math.max(int("JOB_LEASE_SECONDS", 120), 30), 3600);
  },
};

export const DEFAULT_WORKSPACE_ID = "00000000-0000-4000-8000-000000000001";
