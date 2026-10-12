import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface AgentConfig {
  server: string;
  deviceId: string;
  name: string;
  token: string;
  workDir: string;
  /** Manual adapter: download the source video into the job folder for reference. */
  manualDownloadSource: boolean;
}

export const AGENT_VERSION = "1.0.0";

export function configPath(): string {
  return process.env.REELREVIEW_AGENT_CONFIG ?? path.join(os.homedir(), ".reelreview-agent", "config.json");
}

export function loadConfig(): AgentConfig | null {
  try {
    const cfg = JSON.parse(fs.readFileSync(configPath(), "utf8")) as AgentConfig;
    if (!cfg.server || !cfg.token) return null;
    return { ...cfg, manualDownloadSource: cfg.manualDownloadSource ?? false };
  } catch {
    return null;
  }
}

export function saveConfig(cfg: AgentConfig) {
  const file = configPath();
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  // the device token is a credential: owner-only permissions
  fs.writeFileSync(file, JSON.stringify(cfg, null, 2), { mode: 0o600 });
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    /* not supported on some filesystems (e.g. Windows); ACLs apply instead */
  }
}

export function defaultWorkDir(): string {
  return path.join(os.homedir(), "ReelReview Jobs");
}

export function assertSafeServerUrl(server: string): string {
  const u = new URL(server);
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname) || u.hostname.endsWith(".localhost");
  if (u.protocol !== "https:" && !local) {
    throw new Error("Refusing to send the device token over plain HTTP to a non-local server. Use https://.");
  }
  return u.origin;
}
