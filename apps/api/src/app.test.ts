import { mkdtemp, readFile, writeFile } from "node:fs/promises";
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

  it("lets only one of two concurrent deliver calls reach the destination adapter", async () => {
    const { app } = await testApp();
    await app.inject({ method: "POST", url: "/v1/intake/manual", payload: { ...manualMeeting, sourceMeetingId: "manual-concurrent-1" } });
    const proposals = await app.inject({ method: "GET", url: "/v1/proposals" });
    const obsidian = (proposals.json().data as Array<{ id: string; target: string }>).find((proposal) => proposal.target === "obsidian")!;
    await app.inject({ method: "POST", url: `/v1/proposals/${obsidian.id}/approve` });

    const [first, second] = await Promise.all([
      app.inject({ method: "POST", url: `/v1/proposals/${obsidian.id}/deliver` }),
      app.inject({ method: "POST", url: `/v1/proposals/${obsidian.id}/deliver` }),
    ]);
    const statuses = [first.statusCode, second.statusCode].sort();
    expect(statuses).toEqual([200, 409]);
    const delivered = first.statusCode === 200 ? first : second;
    expect(delivered.json().data.proposal.deliveryAttempt).toBe(1);
  });

  it("moves a proposal stuck in delivering to unknown on restart, then lets it be reconciled and retried", async () => {
    const { app, root } = await testApp();
    await app.inject({ method: "POST", url: "/v1/intake/manual", payload: { ...manualMeeting, sourceMeetingId: "manual-crash-1" } });
    const proposals = await app.inject({ method: "GET", url: "/v1/proposals" });
    const obsidian = (proposals.json().data as Array<{ id: string; target: string }>).find((proposal) => proposal.target === "obsidian")!;
    await app.inject({ method: "POST", url: `/v1/proposals/${obsidian.id}/approve` });

    const statePath = join(root, "state.json");
    const crashed = JSON.parse(await readFile(statePath, "utf8"));
    const stuck = crashed.proposals.find((proposal: { id: string }) => proposal.id === obsidian.id);
    stuck.status = "delivering";
    stuck.leaseId = "11111111-1111-4111-8111-111111111111";
    stuck.leaseExpiresAt = "2026-08-12T09:00:00.000Z";
    stuck.deliveryStartedAt = "2026-08-12T08:59:00.000Z";
    await writeFile(statePath, JSON.stringify(crashed, null, 2));

    const config = loadConfig({ NODE_ENV: "test", MEETING_ROUTER_STATE_PATH: statePath, OBSIDIAN_OUTPUT_ROOT: join(root, "obsidian"), CRM_BASE_URL: "http://127.0.0.1:4100" });
    const restarted = await buildApp(config);
    apps.push(restarted);

    const recovered = await restarted.inject({ method: "GET", url: `/v1/proposals/${obsidian.id}` });
    expect(recovered.json().data.status).toBe("unknown");

    const blockedRetry = await restarted.inject({ method: "POST", url: `/v1/proposals/${obsidian.id}/deliver` });
    expect(blockedRetry.statusCode).toBe(409);

    const reconciled = await restarted.inject({ method: "POST", url: `/v1/proposals/${obsidian.id}/reconcile`, payload: { decision: "retry", note: "Confirmed no artifact was written before the crash" } });
    expect(reconciled.statusCode).toBe(200);
    expect(reconciled.json().data.status).toBe("failed");

    const retried = await restarted.inject({ method: "POST", url: `/v1/proposals/${obsidian.id}/deliver` });
    expect(retried.statusCode).toBe(200);
    expect(retried.json().data.proposal.status).toBe("delivered");
  });

  it("accepts agent-supplied meeting context as pending proposals only", async () => {
    const { app } = await testApp();
    const intake = await app.inject({
      method: "POST",
      url: "/v1/intake/agent",
      payload: { ...manualMeeting, source: "fireflies", sourceMeetingId: "agent-fireflies-1" },
    });
    expect(intake.statusCode).toBe(202);
    const proposals = await app.inject({ method: "GET", url: "/v1/proposals" });
    expect(proposals.json().data).toHaveLength(2);
    expect((proposals.json().data as Array<{ status: string }>).every((proposal) => proposal.status === "pending")).toBe(true);
    const meetings = await app.inject({ method: "GET", url: "/v1/meetings" });
    expect(meetings.json().data[0].provenance.transport).toBe("mcp");
  });
});
