import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import { JsonRouterStore } from "./store.js";
import { InMemoryCrmLookup, type RoutingProposal } from "@meeting-context-router/core";

const apps: Awaited<ReturnType<typeof buildApp>>[] = [];
afterEach(async () => { await Promise.all(apps.splice(0).map((app) => app.close())); });
const source = {
  sourceMeetingId: "synthetic-edit-test", title: "Synthetic review", startedAt: "2026-01-15T09:00:00.000Z",
  participants: [], summary: "Original summary", actionItems: [], decisions: [], transcript: [],
};
async function setup() {
  const root = await mkdtemp(join(tmpdir(), "router-edit-"));
  const statePath = join(root, "state.json");
  const app = await buildApp(loadConfig({ NODE_ENV: "test", MEETING_ROUTER_STATE_PATH: statePath, OBSIDIAN_OUTPUT_ROOT: join(root, "notes") }));
  apps.push(app);
  await app.inject({ method: "POST", url: "/v1/intake/manual", payload: source });
  const proposals = (await app.inject({ method: "GET", url: "/v1/proposals" })).json().data as RoutingProposal[];
  return { app, statePath, proposals };
}
const changes = {
  title: "Reviewed title", summary: "Reviewed summary",
  actionItems: [{ description: "Check synthetic fixture", assigneeName: null, assigneeEmail: null, dueOn: null, completed: false, evidenceTimestamp: null }],
  targetNotes: ["Projects/Synthetic review"],
};

describe("pending proposal editing", () => {
  it("keeps participant match previews through editing and persistence", async () => {
    const root = await mkdtemp(join(tmpdir(), "router-match-"));
    const statePath = join(root, "state.json");
    const store = new JsonRouterStore(statePath, {}, new InMemoryCrmLookup(
      [{ id: "person-fixture", name: "Avery Reed", email: "avery@acme.example" }], [],
    ));
    const app = await buildApp(loadConfig({ NODE_ENV: "test", MEETING_ROUTER_STATE_PATH: statePath,
      OBSIDIAN_OUTPUT_ROOT: join(root, "notes") }), store);
    apps.push(app);
    await app.inject({ method: "POST", url: "/v1/intake/manual", payload: {
      ...source, sourceMeetingId: "synthetic-match-test",
      participants: [{ name: "Avery Reed", email: "avery@acme.example", external: true }],
    } });
    const original = ((await app.inject({ method: "GET", url: "/v1/proposals" })).json().data as RoutingProposal[])
      .find((proposal) => proposal.target === "crm")!;
    expect(original.participantMatches?.[0]).toMatchObject({ status: "matched", reason: "exact-email", personId: "person-fixture" });
    const edited = (await app.inject({ method: "PATCH", url: `/v1/proposals/${original.id}`,
      payload: { expectedRevision: 0, changes: { summary: "Reviewed summary" } } })).json().data as RoutingProposal;
    expect(edited.participantMatches).toEqual(original.participantMatches);
    const reloaded = new JsonRouterStore(statePath);
    await reloaded.init();
    expect(reloaded.getProposal(original.id).participantMatches).toEqual(original.participantMatches);
  });
  it("persists attributed before/after history and preserves identity, source and replay deduplication", async () => {
    const { app, statePath, proposals } = await setup();
    for (const original of proposals) {
      const response = await app.inject({ method: "PATCH", url: `/v1/proposals/${original.id}`, payload: { expectedRevision: 0, changes } });
      expect(response.statusCode).toBe(200);
      const edited = response.json().data as RoutingProposal;
      expect(edited).toMatchObject({ id: original.id, meetingId: original.meetingId, idempotencyKey: original.idempotencyKey, status: "pending", reviewedAt: null, deliveredAt: null, targetNotes: changes.targetNotes, payload: { title: changes.title, summary: changes.summary, actionItems: changes.actionItems } });
      expect(edited.editHistory).toEqual([{ revision: 1, actor: "anonymous-dev", editedAt: expect.any(String), before: { title: source.title, summary: source.summary, actionItems: [], targetNotes: [] }, after: changes }]);
      expect(edited.evidence).toEqual(original.evidence);
    }
    const replay = await app.inject({ method: "POST", url: "/v1/intake/manual", payload: source });
    expect(replay.statusCode).toBe(200);
    expect(replay.json().data.duplicate).toBe(true);
    expect(replay.json().data.proposalIds).toEqual(proposals.map((proposal) => proposal.id));
    const store = new JsonRouterStore(statePath);
    await store.init();
    expect(store.listProposals()).toHaveLength(2);
    expect(store.getMeeting(proposals[0]!.meetingId).title).toBe(source.title);
    expect(store.getProposal(proposals[0]!.id).editHistory).toHaveLength(1);
    const second = await app.inject({ method: "PATCH", url: `/v1/proposals/${proposals[0]!.id}`, payload: { expectedRevision: 1, changes: { summary: "Second review" } } });
    expect(second.json().data.editHistory[0].after).toEqual(changes);
    expect(second.json().data.editHistory[1].before).toEqual(changes);
  });

  it("rejects stale and concurrent edits without silently losing a revision", async () => {
    const { app, proposals } = await setup();
    const id = proposals[0]!.id;
    const responses = await Promise.all(["First", "Second"].map((title) => app.inject({ method: "PATCH", url: `/v1/proposals/${id}`, payload: { expectedRevision: 0, changes: { title } } })));
    expect(responses.map((response) => response.statusCode).sort()).toEqual([200, 409]);
    const saved = (await app.inject({ method: "GET", url: `/v1/proposals/${id}` })).json().data;
    expect(saved.editHistory).toHaveLength(1);
  });

  it("locks reviewed proposals, including after successful synthetic delivery", async () => {
    const { app, proposals } = await setup();
    const obsidian = proposals.find((proposal) => proposal.target === "obsidian")!;
    const crm = proposals.find((proposal) => proposal.target === "crm")!;
    expect((await app.inject({ method: "POST", url: `/v1/proposals/${obsidian.id}/approve` })).statusCode).toBe(200);
    const patch = (id: string) => app.inject({ method: "PATCH", url: `/v1/proposals/${id}`, payload: { expectedRevision: 0, changes } });
    expect((await patch(obsidian.id)).statusCode).toBe(409);
    expect((await app.inject({ method: "POST", url: `/v1/proposals/${obsidian.id}/deliver` })).statusCode).toBe(200);
    expect((await patch(obsidian.id)).statusCode).toBe(409);
    await app.inject({ method: "POST", url: `/v1/proposals/${crm.id}/reject` });
    expect((await patch(crm.id)).statusCode).toBe(409);
  });

  it("rejects identity/history/payload replacement, unknown fields and invalid edits atomically", async () => {
    const { app, proposals } = await setup();
    const original = proposals[0]!;
    for (const input of [
      { changes: { title: "No revision" } },
      { expectedRevision: 0, changes: {} },
      { expectedRevision: 0, changes: { title: " " } },
      { expectedRevision: 0, changes: { target: "obsidian" } },
      { expectedRevision: 0, changes: { idempotencyKey: "a".repeat(64) } },
      { expectedRevision: 0, changes: { payload: {} } },
      { expectedRevision: 0, changes: { actionItems: [{ description: "invalid" }] } },
      { expectedRevision: 0, changes: { targetNotes: ["a".repeat(501)] } },
      { expectedRevision: 0, changes: { title: "valid" }, editHistory: [] },
    ]) {
      expect((await app.inject({ method: "PATCH", url: `/v1/proposals/${original.id}`, payload: input })).statusCode).toBe(422);
    }
    expect((await app.inject({ method: "GET", url: `/v1/proposals/${original.id}` })).json().data).toEqual(original);
    expect((await app.inject({ method: "PATCH", url: "/v1/proposals/00000000-0000-4000-8000-000000000000", payload: { expectedRevision: 0, changes } })).statusCode).toBe(404);
  });
});
