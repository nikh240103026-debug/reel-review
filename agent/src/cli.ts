#!/usr/bin/env node
/**
 * ReelReview local editing agent.
 *
 *   npm run agent -- register --server https://review.example.com --code ABCD-EFGH-JKLM [--name "Edit bay 1"] [--work-dir PATH]
 *   npm run agent -- start [--once]
 *   npm run agent -- status
 *   npm run agent -- forget
 *
 * The agent only makes outbound HTTPS requests, authenticates with a device
 * token, receives approved jobs only, and executes only catalog operations
 * through its adapters. It never runs commands sent by the server or by AI.
 */
import fs from "node:fs";
import os from "node:os";
import { AgentClient } from "./client";
import { AGENT_VERSION, assertSafeServerUrl, configPath, defaultWorkDir, loadConfig, saveConfig } from "./config";
import { createAdapters, detectCapabilities } from "./adapters";
import { AgentRunner } from "./runner";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const flag = (name: string) => process.argv.includes(`--${name}`);

async function main() {
  const cmd = process.argv[2];
  const adapters = createAdapters();

  if (cmd === "register") {
    const server = assertSafeServerUrl(arg("server") ?? "");
    const code = arg("code");
    if (!code) throw new Error("--code is required (create one in Settings → Editing devices)");
    const { caps, available } = await detectCapabilities(adapters);
    const client = new AgentClient(server, null);
    const res = await client.register({
      code,
      platform: `${os.platform()} ${os.release()}`,
      agentVersion: AGENT_VERSION,
      adapters: available,
      capabilities: { adapters: Object.fromEntries(caps.map((c) => [c.id, { implemented: c.implemented, supportedOps: c.supportedOps, details: c.details }])) },
    });
    const workDir = arg("work-dir") ?? defaultWorkDir();
    fs.mkdirSync(workDir, { recursive: true });
    saveConfig({ server, deviceId: res.deviceId, name: arg("name") ?? res.name, token: res.token, workDir, manualDownloadSource: false });
    console.log(`Registered "${res.name}" (${res.deviceId}).`);
    console.log(`Adapters available: ${available.join(", ") || "none"}`);
    console.log(`Config saved to ${configPath()} (contains the device token; keep it private).`);
    console.log(`Job folders: ${workDir}`);
    console.log(`Start with: npm run agent -- start`);
    return;
  }

  if (cmd === "status") {
    const { caps } = await detectCapabilities(adapters);
    const cfg = loadConfig();
    console.log(cfg ? `Registered as "${cfg.name}" with ${cfg.server}` : "Not registered.");
    for (const c of caps) {
      console.log(`- ${c.label}: ${c.implemented ? "available" : "not implemented/unavailable"}${c.supportedOps.length ? ` · ops: ${c.supportedOps.join(", ")}` : ""}`);
      if (Object.keys(c.details).length) console.log(`    ${JSON.stringify(c.details)}`);
    }
    return;
  }

  if (cmd === "forget") {
    fs.rmSync(configPath(), { force: true });
    console.log("Local registration removed. Also revoke the device in Settings so its token can never be used again.");
    return;
  }

  if (cmd === "start") {
    const cfg = loadConfig();
    if (!cfg) throw new Error(`Not registered. Run: npm run agent -- register --server URL --code CODE`);
    assertSafeServerUrl(cfg.server);
    const runner = new AgentRunner(cfg, adapters, { once: flag("once") });
    const stop = () => {
      console.log("Stopping after the current step…");
      runner.stop();
    };
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
    const n = await runner.run();
    if (flag("once")) console.log(`Processed ${n} job(s).`);
    return;
  }

  console.log("Usage: npm run agent -- <register|start|status|forget> [options]  (see agent/README.md)");
  process.exitCode = 1;
}

main().catch((err) => {
  console.error(`Error: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
