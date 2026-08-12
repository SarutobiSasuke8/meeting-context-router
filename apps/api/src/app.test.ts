import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";

const apps: Awaited<ReturnType<typeof buildApp>>[] = [];
afterEach(async () => { await Promise.all(apps.splice(0).map((app) => app.close())); });

async function testApp() {
  const root = await mkdtemp(join(tmpdir(), "meeting-router-"));
  const config = loadConfig({
    NODE_ENV: "test",
    MEETING_ROUTER_STATE_PATH: join(root, "state.json"),
    OBSIDIAN_OUTPUT_ROOT: join(root, "obsidian"),
    CRM_BASE_URL: "http://127.0.0.1:4100",
  });
  const app = await buildApp(config);
  apps.push(app);
  return { app, root };
}

const manualMeeting = {
  sourceMeetingId: "manual-test-1",
  title: "Product review",
  startedAt: "2026-08-12T09:00:00.000Z",
  endedAt: "2026-08-12T09:30:00.000Z",
  participants: [{ name: "Alex", email: "alex@example.com", external: false }],
  summary: "Reviewed the launch plan.",
  decisions: ["Launch Friday"],
  actionItems: [{ description: "Ship the release", completed: false }],
  transcript: [],
};

describe("proposal-first routing API", () => {
  it("ingests without delivering, deduplicates, then requires approve before delivery", async () => {
    const { app, root } = await testApp();
    const first = await app.inject({ method: "POST", url: "/v1/intake/manual", payload: manualMeeting });
    expect(first.statusCode).toBe(202);
    const ids = first.json().data.proposalIds as string[];
    const replay = await app.inject({ method: "POST", url: "/v1/intake/manual", payload: manualMeeting });
    expect(replay.statusCode).toBe(200);
    expect(replay.json().data.duplicate).toBe(true);

    const proposals = await app.inject({ method: "GET", url: "/v1/proposals" });
    expect(proposals.json().data).toHaveLength(2);
    const obsidian = (proposals.json().data as Array<{ id: string; target: string }>).find((proposal) => proposal.target === "obsidian");
    expect(obsidian).toBeDefined();
    const earlyDelivery = await app.inject({ method: "POST", url: `/v1/proposals/${obsidian!.id}/deliver` });
    expect(earlyDelivery.statusCode).toBe(409);
    expect((await readFile(join(root, "state.json"), "utf8"))).not.toContain('"status": "delivered"');

    expect((await app.inject({ method: "POST", url: `/v1/proposals/${obsidian!.id}/approve` })).statusCode).toBe(200);
    const delivery = await app.inject({ method: "POST", url: `/v1/proposals/${obsidian!.id}/deliver` });
    expect(delivery.statusCode).toBe(200);
    expect(delivery.json().data.proposal.status).toBe("delivered");
    expect(ids).toContain(obsidian!.id);
  });

  it("blocks CRM delivery truthfully while the CRM has no activity route", async () => {
    const { app } = await testApp();
    await app.inject({ method: "POST", url: "/v1/intake/manual", payload: { ...manualMeeting, sourceMeetingId: "manual-test-2" } });
    const proposals = await app.inject({ method: "GET", url: "/v1/proposals" });
    const crm = (proposals.json().data as Array<{ id: string; target: string }>).find((proposal) => proposal.target === "crm")!;
    await app.inject({ method: "POST", url: `/v1/proposals/${crm.id}/approve` });
    const delivery = await app.inject({ method: "POST", url: `/v1/proposals/${crm.id}/deliver` });
    expect(delivery.statusCode).toBe(409);
    expect(delivery.json().data.proposal.status).toBe("blocked");
    expect(delivery.json().error.message).toContain("meeting/activity endpoint");
  });
});
