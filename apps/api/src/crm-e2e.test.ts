/**
 * End-to-end proof against a real, locally running Agent CRM API
 * (SarutobiSasuke8/agent-crm, `POST /v1/activities/meetings`).
 *
 * Skipped unless both are set:
 *   AGENT_CRM_E2E_BASE_URL  loopback origin of the running CRM API, e.g. http://127.0.0.1:4100
 *   AGENT_CRM_E2E_TOKEN     a CRM API key with scopes records:read,activities:write
 *
 * The test refuses any non-loopback base URL: it writes synthetic records and
 * must never run against a hosted CRM. Every run uses fresh source meeting
 * ids, so earlier runs leave no replay state behind.
 */
import { randomUUID } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { deliverCrmProposal } from "@meeting-context-router/destination-crm";
import type { RoutingProposal } from "@meeting-context-router/core";
import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";

const crmBaseUrl = process.env.AGENT_CRM_E2E_BASE_URL?.trim() ?? "";
const crmToken = process.env.AGENT_CRM_E2E_TOKEN?.trim() ?? "";
const configured = Boolean(crmBaseUrl && crmToken);
const E2E_TIMEOUT = 60_000;

const apps: Awaited<ReturnType<typeof buildApp>>[] = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

const REVIEWER_TOKEN = "e2e-reviewer-token-0000000000000000";
const auth = { authorization: `Bearer ${REVIEWER_TOKEN}` };

async function routerApp() {
  const root = await mkdtemp(join(tmpdir(), "meeting-router-e2e-"));
  const config = loadConfig({
    NODE_ENV: "test",
    MEETING_ROUTER_STATE_PATH: join(root, "state.json"),
    OBSIDIAN_OUTPUT_ROOT: join(root, "obsidian"),
    CRM_BASE_URL: crmBaseUrl,
    CRM_API_TOKEN: crmToken,
    MEETING_ROUTER_PRINCIPALS: JSON.stringify([
      { id: "e2e-reviewer", type: "human", token: REVIEWER_TOKEN, scopes: ["meeting:ingest", "meeting:read", "proposal:read", "proposal:review", "proposal:deliver"] },
    ]),
  });
  const app = await buildApp(config);
  apps.push(app);
  return { app, config };
}

function canonicalMeeting(sourceMeetingId: string) {
  return {
    sourceMeetingId,
    title: "Router to Agent CRM end-to-end proof",
    startedAt: "2026-10-16T09:00:00.000Z",
    endedAt: "2026-10-16T09:40:00.000Z",
    sourceUrl: null,
    participants: [
      { name: "Alexei Udall", email: null, external: false },
      // maya@northstar.example exists in the CRM demo seed; matching is best effort and not asserted.
      { name: "Maya Chen", email: "maya@northstar.example", external: true },
      { name: "Nobody Known", email: "nobody@router-e2e.example", external: true },
    ],
    summary: "Synthetic meeting used to prove router to CRM delivery. Contains no real meeting content.",
    decisions: ["Deliver meeting activities to the Agent CRM through the router"],
    actionItems: [
      { description: "Merge the router CRM delivery PR", assigneeName: "Alexei Udall", assigneeEmail: null, dueOn: "2026-10-20", completed: false, evidenceTimestamp: "00:05:00" },
    ],
    transcript: [{ speaker: "Alexei Udall", email: null, text: "This transcript line must never reach the CRM.", timestamp: "00:00:01" }],
  };
}

async function approvedCrmProposal(app: Awaited<ReturnType<typeof buildApp>>, sourceMeetingId: string) {
  const intake = await app.inject({ method: "POST", url: "/v1/intake/agent", headers: auth, payload: { ...canonicalMeeting(sourceMeetingId), source: "generic" } });
  expect(intake.statusCode).toBe(202);
  const proposals = (await app.inject({ method: "GET", url: "/v1/proposals", headers: auth })).json().data as RoutingProposal[];
  const crm = proposals.find((proposal) => proposal.target === "crm" && proposal.meetingId === intake.json().data.meetingId)!;
  expect(crm.status).toBe("pending");
  expect((await app.inject({ method: "POST", url: `/v1/proposals/${crm.id}/approve`, headers: auth })).statusCode).toBe(200);
  return crm;
}

async function crmActivities(sourceMeetingId: string) {
  const response = await fetch(`${crmBaseUrl}/v1/activities/meetings?sourceMeetingId=${encodeURIComponent(sourceMeetingId)}`, { headers: { authorization: `Bearer ${crmToken}` } });
  expect(response.status).toBe(200);
  return (await response.json() as { data: Array<Record<string, unknown>> }).data;
}

if (!configured) {
  describe("Agent CRM end-to-end delivery", () => {
    it.skip("skipped: set AGENT_CRM_E2E_BASE_URL and AGENT_CRM_E2E_TOKEN to a local Agent CRM to run the end-to-end proof", () => undefined);
  });
}

describe.runIf(configured)("Agent CRM end-to-end delivery", () => {
  it("refuses to run against anything but a loopback CRM", () => {
    const hostname = new URL(crmBaseUrl).hostname;
    expect(["127.0.0.1", "localhost", "::1", "[::1]"]).toContain(hostname);
  });

  it("delivers one approved meeting into the CRM exactly once, with a stable receipt and no duplicate on replay", async () => {
    const sourceMeetingId = `router-e2e-${randomUUID()}`;
    const { app, config } = await routerApp();
    expect((await app.inject({ method: "GET", url: "/health/ready" })).json().crmConfigured).toBe(true);
    expect(await crmActivities(sourceMeetingId)).toHaveLength(0);

    const crm = await approvedCrmProposal(app, sourceMeetingId);
    const delivery = await app.inject({ method: "POST", url: `/v1/proposals/${crm.id}/deliver`, headers: auth });
    expect(delivery.statusCode, delivery.body).toBe(200);
    const delivered = delivery.json().data as { proposal: RoutingProposal; destinationStatus: number; destinationReceiptId: string; replayed: boolean; matchedPersonCount: number };
    expect(delivered.proposal.status).toBe("delivered");
    expect(delivered.destinationStatus).toBe(201);
    expect(delivered.replayed).toBe(false);
    expect(delivered.destinationReceiptId).toMatch(/^[0-9a-f-]{36}$/);

    // The CRM holds exactly the approved payload, matched by source meeting id.
    const records = await crmActivities(sourceMeetingId);
    expect(records).toHaveLength(1);
    const record = records[0]!;
    const meeting = canonicalMeeting(sourceMeetingId);
    expect(record).toMatchObject({
      id: delivered.destinationReceiptId,
      source: "generic",
      sourceMeetingId,
      title: meeting.title,
      startedAt: meeting.startedAt,
      endedAt: meeting.endedAt,
      summary: meeting.summary,
      decisions: meeting.decisions,
      participantEmails: ["maya@northstar.example", "nobody@router-e2e.example"],
    });
    expect(record.actionItems).toEqual(meeting.actionItems);
    expect(Array.isArray(record.matchedPersonIds)).toBe(true);
    expect((record.matchedPersonIds as string[]).length).toBe(delivered.matchedPersonCount);
    expect(JSON.stringify(record)).not.toContain("transcript line");

    // The router recorded the receipt on the durable attempt.
    const attempts = (await app.inject({ method: "GET", url: `/v1/proposals/${crm.id}/attempts`, headers: auth })).json().data as Array<Record<string, unknown>>;
    expect(attempts).toHaveLength(1);
    expect(attempts[0]).toMatchObject({ outcome: "delivered", destinationStatus: 201, destinationReceiptId: delivered.destinationReceiptId, idempotencyKey: crm.idempotencyKey });

    // Replaying the same idempotency key returns the original record and creates nothing.
    const replay = await deliverCrmProposal(delivered.proposal, config.crm);
    expect(replay).toMatchObject({ status: 200, receiptId: delivered.destinationReceiptId, replayed: true });
    expect(await crmActivities(sourceMeetingId)).toHaveLength(1);
    expect((await app.inject({ method: "POST", url: `/v1/proposals/${crm.id}/deliver`, headers: auth })).statusCode).toBe(409);
  }, E2E_TIMEOUT);

  it("reconciles an ambiguous delivery by replaying the same idempotency key, without a duplicate", async () => {
    const sourceMeetingId = `router-e2e-${randomUUID()}`;
    const { app } = await routerApp();
    const crm = await approvedCrmProposal(app, sourceMeetingId);

    // The request reaches the CRM and is committed, but the response is lost in flight.
    const realFetch = globalThis.fetch;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      await realFetch(input, init);
      throw new TypeError("socket hang up after the request was sent");
    }));
    const ambiguous = await app.inject({ method: "POST", url: `/v1/proposals/${crm.id}/deliver`, headers: auth });
    vi.unstubAllGlobals();
    expect(ambiguous.statusCode).toBe(502);
    expect(ambiguous.json().error.code).toBe("delivery_unknown");
    expect(ambiguous.json().data.proposal.status).toBe("unknown");
    const deadLetter = (await app.inject({ method: "GET", url: "/v1/deliveries/dead-letter", headers: auth })).json().data as Array<{ proposal: { id: string } }>;
    expect(deadLetter.map((entry) => entry.proposal.id)).toContain(crm.id);
    expect(await crmActivities(sourceMeetingId)).toHaveLength(1);

    // Reconciliation: deliver again with the same key; the CRM replays the original record.
    const reconciled = await app.inject({ method: "POST", url: `/v1/proposals/${crm.id}/deliver`, headers: auth });
    expect(reconciled.statusCode, reconciled.body).toBe(200);
    expect(reconciled.json().data).toMatchObject({ proposal: { status: "delivered" }, destinationStatus: 200, replayed: true });
    const records = await crmActivities(sourceMeetingId);
    expect(records).toHaveLength(1);
    expect(records[0]!.id).toBe(reconciled.json().data.destinationReceiptId);
    const attempts = (await app.inject({ method: "GET", url: `/v1/proposals/${crm.id}/attempts`, headers: auth })).json().data as Array<{ outcome: string; idempotencyKey: string }>;
    expect(attempts.map((attempt) => attempt.outcome)).toEqual(["unknown", "delivered"]);
    expect(new Set(attempts.map((attempt) => attempt.idempotencyKey)).size).toBe(1);
    expect((await app.inject({ method: "GET", url: "/v1/deliveries/dead-letter", headers: auth })).json().data).toHaveLength(0);
  }, E2E_TIMEOUT);
});
