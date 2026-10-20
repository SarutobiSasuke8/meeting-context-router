import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";

const CRM_TOKEN = "crm-test-token-0000000000000000";
const ACTIVITY_ID = "a0000000-0000-4000-8000-000000000001";

const apps: Awaited<ReturnType<typeof buildApp>>[] = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

async function testApp(extraEnvironment: Record<string, string> = {}) {
  const root = await mkdtemp(join(tmpdir(), "meeting-router-"));
  const config = loadConfig({
    NODE_ENV: "test",
    MEETING_ROUTER_STATE_PATH: join(root, "state.json"),
    OBSIDIAN_OUTPUT_ROOT: join(root, "obsidian"),
    CRM_BASE_URL: "http://127.0.0.1:4100",
    ...extraEnvironment,
  });
  const app = await buildApp(config);
  apps.push(app);
  return { app, root };
}

function crmResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

async function approvedCrmProposal(app: Awaited<ReturnType<typeof buildApp>>, sourceMeetingId: string) {
  const intake = await app.inject({ method: "POST", url: "/v1/intake/manual", payload: { ...manualMeeting, sourceMeetingId } });
  expect(intake.statusCode).toBe(202);
  const proposals = await app.inject({ method: "GET", url: "/v1/proposals" });
  const crm = (proposals.json().data as Array<{ id: string; target: string; meetingId: string; idempotencyKey: string }>)
    .find((proposal) => proposal.target === "crm" && proposal.meetingId === intake.json().data.meetingId)!;
  expect((await app.inject({ method: "POST", url: `/v1/proposals/${crm.id}/approve` })).statusCode).toBe(200);
  return crm;
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
  it("lists adapter capabilities through the existing read scope", async () => {
    const { app } = await testApp();
    const response = await app.inject({ method: "GET", url: "/v1/capabilities" });
    expect(response.statusCode).toBe(200);
    expect(response.json().data.sources.fathom.supports.webhooks).toBe(true);
    expect(response.json().data.destinations.obsidian.supports.transcript).toBe(false);
  });

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

  it("blocks CRM delivery truthfully while no CRM token is configured", async () => {
    const { app } = await testApp();
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    await app.inject({ method: "POST", url: "/v1/intake/manual", payload: { ...manualMeeting, sourceMeetingId: "manual-test-2" } });
    const proposals = await app.inject({ method: "GET", url: "/v1/proposals" });
    const crm = (proposals.json().data as Array<{ id: string; target: string }>).find((proposal) => proposal.target === "crm")!;
    await app.inject({ method: "POST", url: `/v1/proposals/${crm.id}/approve` });
    const delivery = await app.inject({ method: "POST", url: `/v1/proposals/${crm.id}/deliver` });
    expect(delivery.statusCode).toBe(409);
    expect(delivery.json().data.proposal.status).toBe("blocked");
    expect(delivery.json().error.message).toContain("CRM_API_TOKEN");
    expect(fetchSpy).not.toHaveBeenCalled();
  }, 30_000);

  it("delivers an approved CRM proposal to the configured Agent CRM route and records the receipt", async () => {
    const { app } = await testApp({ CRM_API_TOKEN: CRM_TOKEN });
    const fetchSpy = vi.fn().mockResolvedValue(crmResponse(201, { data: { id: ACTIVITY_ID, sourceMeetingId: "manual-test-3", matchedPersonIds: [] }, meta: { replayed: false } }));
    vi.stubGlobal("fetch", fetchSpy);
    const crm = await approvedCrmProposal(app, "manual-test-3");
    const delivery = await app.inject({ method: "POST", url: `/v1/proposals/${crm.id}/deliver` });
    expect(delivery.statusCode).toBe(200);
    expect(delivery.json().data).toMatchObject({ proposal: { status: "delivered" }, destinationStatus: 201, destinationReceiptId: ACTIVITY_ID, replayed: false, matchedPersonCount: 0 });
    const [calledUrl, init] = fetchSpy.mock.calls[0] as [URL, RequestInit];
    expect(String(calledUrl)).toBe("http://127.0.0.1:4100/v1/activities/meetings");
    expect(new Headers(init.headers).get("idempotency-key")).toBe(crm.idempotencyKey);
    expect(JSON.parse(String(init.body))).toMatchObject({ source: "manual", sourceMeetingId: "manual-test-3", title: manualMeeting.title, participantEmails: ["alex@example.com"], decisions: ["Launch Friday"], transcriptIncluded: false });
    const attempts = await app.inject({ method: "GET", url: `/v1/proposals/${crm.id}/attempts` });
    expect(attempts.json().data).toHaveLength(1);
    expect(attempts.json().data[0]).toMatchObject({ outcome: "delivered", destinationStatus: 201, destinationReceiptId: ACTIVITY_ID, idempotencyKey: crm.idempotencyKey });
    // A delivered proposal cannot be delivered twice through the API.
    expect((await app.inject({ method: "POST", url: `/v1/proposals/${crm.id}/deliver` })).statusCode).toBe(409);
  }, 30_000);

  it("blocks non-retryable CRM answers and keeps retryable ones in the retry path", async () => {
    const { app } = await testApp({ CRM_API_TOKEN: CRM_TOKEN });
    const fetchSpy = vi.fn()
      .mockResolvedValueOnce(crmResponse(503, { error: { code: "unavailable", message: "database restarting", requestId: "r1" } }))
      .mockResolvedValueOnce(crmResponse(201, { data: { id: ACTIVITY_ID, sourceMeetingId: "manual-test-4", matchedPersonIds: [] }, meta: { replayed: false } }))
      .mockResolvedValueOnce(crmResponse(422, { error: { code: "validation_failed", message: "startedAt invalid", requestId: "r2" } }));
    vi.stubGlobal("fetch", fetchSpy);

    const first = await approvedCrmProposal(app, "manual-test-4");
    const transient = await app.inject({ method: "POST", url: `/v1/proposals/${first.id}/deliver` });
    expect(transient.statusCode).toBe(502);
    expect(transient.json().error.code).toBe("delivery_failed");
    expect((await app.inject({ method: "GET", url: `/v1/proposals/${first.id}` })).json().data.status).toBe("failed");
    const retried = await app.inject({ method: "POST", url: `/v1/proposals/${first.id}/deliver` });
    expect(retried.statusCode).toBe(200);
    expect(retried.json().data.proposal.status).toBe("delivered");
    const attempts = (await app.inject({ method: "GET", url: `/v1/proposals/${first.id}/attempts` })).json().data as Array<{ outcome: string; destinationStatus: number | null; idempotencyKey: string }>;
    expect(attempts.map((attempt) => attempt.outcome)).toEqual(["failed", "delivered"]);
    expect(attempts[0]!.idempotencyKey).toBe(attempts[1]!.idempotencyKey);

    const second = await approvedCrmProposal(app, "manual-test-5");
    const rejected = await app.inject({ method: "POST", url: `/v1/proposals/${second.id}/deliver` });
    expect(rejected.statusCode).toBe(409);
    expect(rejected.json().error.code).toBe("destination_blocked");
    expect(rejected.json().data.proposal.status).toBe("blocked");
    expect(rejected.json().error.message).toContain("HTTP 422");
    expect(rejected.json().error.message).not.toContain(CRM_TOKEN);
    expect(fetchSpy).toHaveBeenCalledTimes(3);
  }, 30_000);

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
    expect(meetings.json().data[0].transport).toBe("mcp");
  });
});
