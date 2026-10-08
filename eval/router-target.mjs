#!/usr/bin/env node
// Offline stdio target for the mcp-eval contract suite (eval/mcp.suite.yaml).
//
// The MCP bridge (apps/mcp) is a thin client of the router HTTP API, so on its own it has
// nothing to talk to. This launcher starts the real router API in-process on a loopback port
// with a throwaway state directory and a synthetic, eval-only bridge token, then loads the
// built MCP stdio entrypoint in the same process. Nothing leaves 127.0.0.1, no real
// credentials are read (the router config is built from an explicit object, not from
// process.env or .env), and stdout stays reserved for MCP JSON-RPC because the router logger
// is silent when NODE_ENV is "test".
//
// Requires `pnpm build` first (npm run eval:contract does this).
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp } from "../apps/api/dist/app.js";
import { loadConfig } from "../apps/api/dist/config.js";

// Synthetic value, valid only for this throwaway loopback router. Not a credential.
const EVAL_BRIDGE_TOKEN = "eval-only-synthetic-bridge-token-000000";

const stateRoot = mkdtempSync(join(tmpdir(), "mcr-eval-"));
let cleaned = false;
function cleanUp() {
  if (cleaned) return;
  cleaned = true;
  try {
    rmSync(stateRoot, { recursive: true, force: true });
  } catch {
    // Best effort: the directory is in the OS temp folder.
  }
}

const config = loadConfig({
  NODE_ENV: "test",
  API_HOST: "127.0.0.1",
  API_PORT: "4300",
  // The bridge principal gets meeting:ingest and proposal:read only, as in production.
  MEETING_ROUTER_MCP_TOKEN: EVAL_BRIDGE_TOKEN,
  MEETING_ROUTER_STATE_PATH: join(stateRoot, "state.json"),
  OBSIDIAN_OUTPUT_ROOT: join(stateRoot, "obsidian"),
});
const app = await buildApp(config);
// Port 0: let the OS pick a free loopback port so parallel runs never collide.
await app.listen({ host: "127.0.0.1", port: 0 });
const address = app.server.address();
if (!address || typeof address === "string") throw new Error("Router did not bind a TCP port");

// The MCP client reads only these variables. Clear the legacy shared token so a value in the
// caller's shell can never reach the bridge.
process.env.ROUTER_BASE_URL = `http://127.0.0.1:${address.port}`;
process.env.MEETING_ROUTER_MCP_TOKEN = EVAL_BRIDGE_TOKEN;
delete process.env.MEETING_ROUTER_API_TOKEN;

async function shutdown() {
  try {
    await app.close();
  } finally {
    cleanUp();
    process.exit(0);
  }
}
process.stdin.on("end", () => void shutdown());
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
process.on("exit", cleanUp);

await import("../apps/mcp/dist/stdio.js");
