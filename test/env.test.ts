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
    expect(() => env.storageDriver).toThrow(/Configure R2_ACCOUNT_ID, S3_BUCKET/);
  });
});
