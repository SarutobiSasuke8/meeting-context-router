import { describe, expect, it } from "vitest";
import { assertRouteSupported, destinationCapabilities, sourceCapabilities } from "./capabilities.js";

describe("adapter capabilities", () => {
  it("declares every source and destination with replay-safe IDs", () => {
    expect(Object.keys(sourceCapabilities).sort()).toEqual(["fathom", "fireflies", "fixtures", "generic", "granola", "manual"]);
    expect(Object.keys(destinationCapabilities).sort()).toEqual(["crm", "obsidian"]);
    for (const manifest of [...Object.values(sourceCapabilities), ...Object.values(destinationCapabilities)]) {
      expect(manifest.supports.replaySafeIds).toBe(true);
      expect(manifest.supports.attachments).toBe(false);
    }
  });

  it("allows routed fields and refuses unsupported transcript or attachments", () => {
    expect(() => assertRouteSupported("fathom", "obsidian", {
      sourceMeetingId: "fixture-1", summary: "Fixture summary", participants: [{ name: "A" }], actionItems: [],
    })).not.toThrow();
    expect(() => assertRouteSupported("fathom", "obsidian", {
      sourceMeetingId: "fixture-2", transcript: [{ text: "fixture" }],
    })).toThrow(/unsupported capabilities: transcript/);
    expect(() => assertRouteSupported("manual", "crm", {
      sourceMeetingId: "fixture-3", attachments: [{ id: "fixture" }],
    })).toThrow(/unsupported capabilities: attachments/);
  });

  it("does not route a field the source adapter cannot provide", () => {
    expect(() => assertRouteSupported("granola", "obsidian", {
      sourceMeetingId: "fixture-4", actionItems: [{ description: "Fixture" }],
    })).toThrow(/unsupported capabilities: actionItems/);
  });
});
