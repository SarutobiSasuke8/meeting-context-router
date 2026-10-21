import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import type { CrmPerson } from "@meeting-context-router/core";
import { JsonRouterStore } from "./store.js";
import { normalizeManualIntake } from "./manual.js";

const input = { sourceMeetingId: "fixture-first", title: "Synthetic", startedAt: "2026-01-15T09:00:00.000Z", summary: "Synthetic" };
it("omits matching evidence when a lookup is unavailable", async () => {
  const root = await mkdtemp(join(tmpdir(), "router-match-unavailable-"));
  const store = new JsonRouterStore(join(root, "state.json"));
  await store.init();
  const result = await store.ingest(normalizeManualIntake(input));
  expect(result.proposals.find((proposal) => proposal.target === "crm")!.participantMatches).toBeUndefined();
});

it("does not hold the mutation queue while awaiting a fixture lookup", async () => {
  const root = await mkdtemp(join(tmpdir(), "router-match-async-"));
  let release!: (people: readonly CrmPerson[]) => void;
  let announce!: () => void;
  const entered = new Promise<void>((resolve) => { announce = resolve; });
  let calls = 0;
  const store = new JsonRouterStore(join(root, "state.json"), {}, {
    people: async () => {
      if (calls++ === 0) return [];
      announce();
      return new Promise((resolve) => { release = resolve; });
    },
    companies: async () => [],
  });
  await store.init();
  const first = await store.ingest(normalizeManualIntake(input));
  const pending = store.ingest(normalizeManualIntake({ ...input, sourceMeetingId: "fixture-second" }));
  await entered;
  try {
    const reviewed = await Promise.race([
      store.reviewProposal(first.proposals[0]!.id, "approved"),
      new Promise<never>((_, reject) => { const timer = setTimeout(() => reject(new Error("Lookup blocked review")), 1_000); timer.unref(); }),
    ]);
    expect(reviewed.status).toBe("approved");
  } finally { release([]); }
  expect((await pending).proposals).toHaveLength(2);
});
