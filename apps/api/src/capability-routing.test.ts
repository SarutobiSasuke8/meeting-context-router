import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import { JsonRouterStore } from "./store.js";
import type { RouterState, RoutingProposal } from "@meeting-context-router/core";

const apps: Awaited<ReturnType<typeof buildApp>>[] = [];
afterEach(async () => { await Promise.all(apps.splice(0).map((app) => app.close())); });
const source = { source: "granola", sourceMeetingId: "fixture-granola", title: "Synthetic",
  startedAt: "2026-01-15T09:00:00.000Z", summary: "Synthetic summary", participants: [], actionItems: [] };
const actionItems = [{ description: "Synthetic action", assigneeName: null, assigneeEmail: null, dueOn: null, completed: false, evidenceTimestamp: null }];

it("rejects unsupported agent intake with 422 and preserves the empty state", async () => {
  const root = await mkdtemp(join(tmpdir(), "router-capabilities-"));
  const app = await buildApp(loadConfig({ NODE_ENV: "test", MEETING_ROUTER_STATE_PATH: join(root, "state.json"), OBSIDIAN_OUTPUT_ROOT: join(root, "notes") }));
  apps.push(app);
  const response = await app.inject({ method: "POST", url: "/v1/intake/agent", payload: { ...source, actionItems } });
  expect(response.statusCode).toBe(422);
  expect(response.json().error.code).toBe("unsupported_route");
  expect((await app.inject({ method: "GET", url: "/v1/proposals" })).json().data).toEqual([]);
  expect((await app.inject({ method: "POST", url: "/v1/intake/agent", payload: source })).statusCode).toBe(202);
});

it("rejects unsupported edits atomically and rechecks persisted proposals before delivery", async () => {
  const root = await mkdtemp(join(tmpdir(), "router-capabilities-"));
  const statePath = join(root, "state.json");
  const config = loadConfig({ NODE_ENV: "test", MEETING_ROUTER_STATE_PATH: statePath, OBSIDIAN_OUTPUT_ROOT: join(root, "notes") });
  const app = await buildApp(config);
  apps.push(app);
  await app.inject({ method: "POST", url: "/v1/intake/agent", payload: source });
  const proposals = (await app.inject({ method: "GET", url: "/v1/proposals" })).json().data as RoutingProposal[];
  const proposal = proposals[0]!;
  expect((await app.inject({ method: "PATCH", url: `/v1/proposals/${proposal.id}`, payload: { expectedRevision: 0, changes: { actionItems } } })).statusCode).toBe(422);
  expect((await app.inject({ method: "GET", url: `/v1/proposals/${proposal.id}` })).json().data).toEqual(proposal);
  await app.close();
  apps.splice(apps.indexOf(app), 1);
  const state = JSON.parse(await readFile(statePath, "utf8")) as RouterState;
  const persisted = state.proposals.find((candidate) => candidate.id === proposal.id)!;
  persisted.status = "approved";
  persisted.payload.actionItems = actionItems;
  await writeFile(statePath, JSON.stringify(state));
  const store = new JsonRouterStore(statePath);
  await store.init();
  await expect(store.beginDelivery(proposal.id, "synthetic-reviewer", 30)).rejects.toThrow(/unsupported capabilities/);
  expect(store.getProposal(proposal.id).status).toBe("approved");
  expect(store.exportMeeting(proposal.meetingId).deliveryAttempts).toHaveLength(0);
});
