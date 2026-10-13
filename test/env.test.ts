import { afterEach, describe, expect, it, vi } from "vitest";
import { ConfigError, env } from "@/lib/env";

describe("environment configuration", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("requires the public app URL in production instead of creating localhost review links", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("APP_URL", "");

    expect(() => env.appUrl).toThrow(ConfigError);
  });

  it("keeps localhost as the development URL when none is configured", () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("APP_URL", "");

    expect(env.appUrl).toBe("http://localhost:3000");
  });

  it("prefers Gemini when both AI provider keys are configured", () => {
    vi.stubEnv("GEMINI_API_KEY", "gemini-test-key");
    vi.stubEnv("GEMINI_MODEL", "");
    vi.stubEnv("ANTHROPIC_API_KEY", "anthropic-test-key");

    expect(env.aiProvider).toBe("gemini");
    expect(env.aiConfigured).toBe(true);
    expect(env.aiModel).toBe("gemini-2.5-flash");
  });

  it("keeps Claude available when Gemini is not configured", () => {
    vi.stubEnv("GEMINI_API_KEY", "");
    vi.stubEnv("ANTHROPIC_API_KEY", "anthropic-test-key");

    expect(env.aiProvider).toBe("claude");
    expect(env.aiModel).toBe(env.anthropicModel);
  });

  it("requires durable database and object storage on Vercel production", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("VERCEL", "1");
    vi.stubEnv("APP_URL", "https://reelreview.com");
    vi.stubEnv("DATABASE_URL", "");
    vi.stubEnv("STORAGE_DRIVER", "");
    vi.stubEnv("R2_ACCOUNT_ID", "");
    vi.stubEnv("S3_ENDPOINT", "");
    vi.stubEnv("S3_BUCKET", "");
    vi.stubEnv("S3_ACCESS_KEY_ID", "");
    vi.stubEnv("S3_SECRET_ACCESS_KEY", "");

    expect(() => env.databaseUrl).toThrow(/DATABASE_URL must be configured/);
    expect(() => env.storageDriver).toThrow(/Configure S3_ENDPOINT \(or R2_ACCOUNT_ID\), S3_BUCKET/);
  });

  it("accepts Supabase Storage S3 credentials for Vercel production", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("VERCEL", "1");
    vi.stubEnv("APP_URL", "https://reelreview.com");
    vi.stubEnv("DATABASE_URL", "postgres://example");
    vi.stubEnv("STORAGE_DRIVER", "");
    vi.stubEnv("R2_ACCOUNT_ID", "");
    vi.stubEnv("S3_ENDPOINT", "https://project-ref.storage.supabase.co/storage/v1/s3");
    vi.stubEnv("S3_BUCKET", "reel-review-media");
    vi.stubEnv("S3_ACCESS_KEY_ID", "test-access-key");
    vi.stubEnv("S3_SECRET_ACCESS_KEY", "test-secret-key");

    expect(env.storageDriver).toBe("s3");
    expect(env.s3.endpoint).toBe("https://project-ref.storage.supabase.co/storage/v1/s3");
  });

  it("defaults Supabase Storage uploads to its free-plan 50 MB per-file limit", () => {
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("S3_ENDPOINT", "https://project-ref.storage.supabase.co/storage/v1/s3");
    vi.stubEnv("MAX_UPLOAD_MB", "");
    vi.stubEnv("MAX_UPLOAD_GB", "20");

    expect(env.maxUploadBytes).toBe(50 * 1024 * 1024);
  });

  it("allows the configured per-file upload limit to override the Supabase default", () => {
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("S3_ENDPOINT", "https://project-ref.storage.supabase.co/storage/v1/s3");
    vi.stubEnv("MAX_UPLOAD_MB", "500");

    expect(env.maxUploadBytes).toBe(500 * 1024 * 1024);
  });
});
