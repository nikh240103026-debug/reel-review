import os from "node:os";
import path from "node:path";
import fs from "node:fs";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "reelreview-test-"));
Object.assign(process.env, {
  NODE_ENV: "test",
  APP_SECRET: "test-app-secret-0123456789abcdefghijklmnop",
  EDITOR_ACCESS_KEY: "test-editor-access-key-123",
  APP_URL: "http://localhost:3999",
  PGLITE_DATA_DIR: "memory",
  STORAGE_DRIVER: "local",
  LOCAL_STORAGE_DIR: path.join(dir, "storage"),
  JOB_LEASE_SECONDS: "60",
});
delete process.env.DATABASE_URL;
delete process.env.ANTHROPIC_API_KEY;
delete process.env.GEMINI_API_KEY;
delete process.env.ANTHROPIC_AUTH_TOKEN;
