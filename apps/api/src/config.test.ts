import { describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";

describe("router configuration", () => {
  it("refuses an unauthenticated non-loopback bind even outside production", () => {
    expect(() => loadConfig({ NODE_ENV: "development", API_HOST: "0.0.0.0" }))
      .toThrow("MEETING_ROUTER_API_TOKEN is required when API_HOST is not loopback");
  });

  it("keeps loopback development usable without persisting a browser token", () => {
    expect(loadConfig({ NODE_ENV: "development", API_HOST: "127.0.0.1" }).apiToken).toBeNull();
  });
});
