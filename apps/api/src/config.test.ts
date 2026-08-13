import { describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";

describe("router configuration", () => {
  it("refuses an unauthenticated non-loopback bind even outside production", () => {
    expect(() => loadConfig({ NODE_ENV: "development", API_HOST: "0.0.0.0" }))
      .toThrow("Authenticated principals are required when API_HOST is not loopback");
  });

  it("keeps loopback development usable without persisting a browser token", () => {
    expect(loadConfig({ NODE_ENV: "development", API_HOST: "127.0.0.1" }).principals).toHaveLength(0);
  });

  it("builds scoped principals from environment configuration", () => {
    const config = loadConfig({
      NODE_ENV: "development",
      MEETING_ROUTER_MCP_TOKEN: "m".repeat(32),
      MEETING_ROUTER_API_TOKEN: "l".repeat(32),
      MEETING_ROUTER_PRINCIPALS: JSON.stringify([
        { id: "reviewer", type: "human", token: "r".repeat(32), scopes: ["proposal:read", "proposal:review"] },
      ]),
    });
    expect(config.principals.map((principal) => principal.id)).toEqual(["reviewer", "mcp-bridge", "legacy-shared-token"]);
    const mcp = config.principals.find((principal) => principal.id === "mcp-bridge")!;
    expect(mcp.scopes).toEqual(["meeting:ingest", "proposal:read"]);
  });

  it("rejects duplicate principal tokens and malformed principal JSON", () => {
    expect(() => loadConfig({ NODE_ENV: "development", MEETING_ROUTER_PRINCIPALS: "not-json" })).toThrow("valid JSON");
    expect(() => loadConfig({
      NODE_ENV: "development",
      MEETING_ROUTER_PRINCIPALS: JSON.stringify([
        { id: "agent-a", token: "t".repeat(32), scopes: ["admin"] },
        { id: "agent-b", token: "t".repeat(32), scopes: ["proposal:read"] },
      ]),
    })).toThrow("share the same token");
  });

  it("requires a 32-byte base64 state key when encryption is configured", () => {
    expect(() => loadConfig({ NODE_ENV: "development", MEETING_ROUTER_STATE_KEY: "shortkey" })).toThrow("32 bytes");
  });
});
