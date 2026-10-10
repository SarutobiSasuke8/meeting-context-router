import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { deliverObsidianProposal, renderObsidianMeeting } from "@meeting-context-router/destination-obsidian";
import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import { JsonRouterStore } from "./store.js";

const MCP_TOKEN = "mcp-token-000000000000000000000000";
const REVIEWER_TOKEN = "reviewer-token-00000000000000000000";
const ADMIN_TOKEN = "admin-token-000000000000000000000000";

const apps: Awaited<ReturnType<typeof buildApp>>[] = [];
afterEach(async () => { await Promise.all(apps.splice(0).map((app) => app.close())); });

async function securedApp(extraEnvironment: Record<string, string> = {}) {
  const root = await mkdtemp(join(tmpdir(), "meeting-router-sec-"));
  const config = loadConfig({
    NODE_ENV: "test",
    MEETING_ROUTER_STATE_PATH: join(root, "state.json"),
    OBSIDIAN_OUTPUT_ROOT: join(root, "obsidian"),
    CRM_BASE_URL: "http://127.0.0.1:4100",
    MEETING_ROUTER_MCP_TOKEN: MCP_TOKEN,
    MEETING_ROUTER_PRINCIPALS: JSON.stringify([
      { id: "reviewer", type: "human", token: REVIEWER_TOKEN, scopes: ["meeting:read", "proposal:read", "proposal:review", "proposal:deliver"] },
      { id: "operator", type: "human", token: ADMIN_TOKEN, scopes: ["admin"] },
    ]),
    ...extraEnvironment,
  });
  const app = await buildApp(config);
  apps.push(app);
  return { app, root, config };
}

const auth = (token: string) => ({ authorization: `Bearer ${token}` });

const meeting = (sourceMeetingId: string) => ({
  sourceMeetingId,
  title: "Security review",
  startedAt: "2026-08-12T09:00:00.000Z",
  endedAt: null,
  participants: [{ name: "Alex", email: "alex@example.com", external: false }],
  summary: "Discussed the plan.",
  decisions: ["Proceed"],
  actionItems: [],
  transcript: [{ speaker: "Alex", text: "This transcript line is sensitive narrative.", timestamp: null }],
});

async function approvedObsidianProposal(app: Awaited<ReturnType<typeof buildApp>>, sourceMeetingId: string) {
  const intake = await app.inject({ method: "POST", url: "/v1/intake/agent", headers: auth(MCP_TOKEN), payload: { ...meeting(sourceMeetingId), source: "generic" } });
  expect(intake.statusCode).toBe(202);
  const proposals = await app.inject({ method: "GET", url: "/v1/proposals", headers: auth(REVIEWER_TOKEN) });
  const obsidian = (proposals.json().data as Array<{ id: string; target: string; meetingId: string }>).find((proposal) => proposal.target === "obsidian")!;
  await app.inject({ method: "POST", url: `/v1/proposals/${obsidian.id}/approve`, headers: auth(REVIEWER_TOKEN) });
  return obsidian;
}

describe("authorization matrix", () => {
  it("rejects missing tokens with 401 and under-scoped principals with 403", async () => {
    const { app } = await securedApp();
    expect((await app.inject({ method: "GET", url: "/v1/proposals" })).statusCode).toBe(401);

    const denied = [
      { method: "POST" as const, url: "/v1/intake/manual", payload: meeting("m-1") },
      { method: "POST" as const, url: "/v1/sources/fathom/sync", payload: {} },
      { method: "POST" as const, url: "/v1/sources/granola/sync", payload: {} },
      { method: "POST" as const, url: `/v1/proposals/6a3c9dfd-98a1-4c25-9a26-2fc4bb2e6f11/approve` },
      { method: "POST" as const, url: `/v1/proposals/6a3c9dfd-98a1-4c25-9a26-2fc4bb2e6f11/reject` },
      { method: "POST" as const, url: `/v1/proposals/6a3c9dfd-98a1-4c25-9a26-2fc4bb2e6f11/deliver` },
      { method: "DELETE" as const, url: `/v1/meetings/6a3c9dfd-98a1-4c25-9a26-2fc4bb2e6f11` },
      { method: "GET" as const, url: `/v1/meetings/6a3c9dfd-98a1-4c25-9a26-2fc4bb2e6f11/export` },
    ];
    // The MCP bridge principal has meeting:ingest and proposal:read only. Even
    // driving the HTTP API directly, it cannot review, deliver, sync, or admin.
    for (const request of denied) {
      const response = await app.inject({ ...request, headers: auth(MCP_TOKEN) });
      expect(response.statusCode, `${request.method} ${request.url}`).toBe(403);
    }

    const allowed = await app.inject({ method: "POST", url: "/v1/intake/agent", headers: auth(MCP_TOKEN), payload: { ...meeting("m-2"), source: "generic" } });
    expect(allowed.statusCode).toBe(202);
    expect((await app.inject({ method: "GET", url: "/v1/proposals", headers: auth(MCP_TOKEN) })).statusCode).toBe(200);
  });

  it("keeps webhook intake signature-gated rather than bearer-gated", async () => {
    const { app } = await securedApp();
    const response = await app.inject({ method: "POST", url: "/v1/intake/fathom", payload: {} });
    expect(response.statusCode).toBe(503);
  });
});

describe("delivery leases and receipts", () => {
  it("persists the attempt before the side effect and refuses concurrent delivery", async () => {
    const { app } = await securedApp();
    const proposal = await approvedObsidianProposal(app, "lease-1");
    const [first, second] = await Promise.all([
      app.inject({ method: "POST", url: `/v1/proposals/${proposal.id}/deliver`, headers: auth(REVIEWER_TOKEN) }),
      app.inject({ method: "POST", url: `/v1/proposals/${proposal.id}/deliver`, headers: auth(REVIEWER_TOKEN) }),
    ]);
    const codes = [first.statusCode, second.statusCode].sort();
    expect(codes).toEqual([200, 409]);

    const attempts = await app.inject({ method: "GET", url: `/v1/proposals/${proposal.id}/attempts`, headers: auth(REVIEWER_TOKEN) });
    const attemptRecords = attempts.json().data as Array<{ outcome: string; actor: string; contentHash: string; idempotencyKey: string }>;
    expect(attemptRecords).toHaveLength(1);
    expect(attemptRecords[0]!.outcome).toBe("delivered");
    expect(attemptRecords[0]!.actor).toBe("reviewer");
    expect(attemptRecords[0]!.contentHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("treats a wrong pre-existing artifact as a conflict, never silent success", async () => {
    const { app, root } = await securedApp();
    const proposal = await approvedObsidianProposal(app, "conflict-1");
    const preview = await app.inject({ method: "GET", url: `/v1/proposals/${proposal.id}`, headers: auth(REVIEWER_TOKEN) });
    const payload = preview.json().data.payload as { startedAt: string; title: string; meetingId: string };
    const filename = `${payload.startedAt.slice(0, 10)} - security-review - ${payload.meetingId.slice(0, 8)}.md`;
    const { mkdir, writeFile: write } = await import("node:fs/promises");
    await mkdir(join(root, "obsidian"), { recursive: true });
    await write(join(root, "obsidian", filename), "# A different artifact entirely\n", "utf8");

    const delivery = await app.inject({ method: "POST", url: `/v1/proposals/${proposal.id}/deliver`, headers: auth(REVIEWER_TOKEN) });
    expect(delivery.statusCode).toBe(409);
    expect(delivery.json().data.proposal.status).toBe("blocked");
    expect(delivery.json().error.message).toContain("does not match");
  });

  it("returns alreadyExisted only for an exact prior delivery of the same proposal", async () => {
    const { app, root } = await securedApp();
    const proposal = await approvedObsidianProposal(app, "idempotent-1");
    // Simulate a crash after the artifact was written but before the receipt:
    // the exact artifact exists, so redelivery must verify identity and succeed.
    const detail = await app.inject({ method: "GET", url: `/v1/proposals/${proposal.id}`, headers: auth(REVIEWER_TOKEN) });
    const { renderObsidianMeeting } = await import("@meeting-context-router/destination-obsidian");
    const rendered = renderObsidianMeeting(detail.json().data);
    const { mkdir, writeFile: write } = await import("node:fs/promises");
    await mkdir(join(root, "obsidian"), { recursive: true });
    await write(join(root, "obsidian", rendered.filename), rendered.markdown, "utf8");

    const delivery = await app.inject({ method: "POST", url: `/v1/proposals/${proposal.id}/deliver`, headers: auth(REVIEWER_TOKEN) });
    expect(delivery.statusCode).toBe(200);
    expect(delivery.json().data.alreadyExisted).toBe(true);
    expect(delivery.json().data.proposal.status).toBe("delivered");
  });

  it("recovers an expired delivering lease deterministically after restart", async () => {
    const { app, config } = await securedApp();
    const proposal = await approvedObsidianProposal(app, "lease-expiry-1");
    await app.close();

    const store = new JsonRouterStore(config.statePath);
    await store.init();
    const stuck = await store.beginDelivery(proposal.id, "crash-test", 1, new Date());
    expect(stuck.outcome).toBeNull();
    expect(store.getProposal(proposal.id).status).toBe("delivering");
    expect(store.listDeadLetter(new Date(Date.now() + 5_000))).toHaveLength(1);

    // Restart: a new store instance sees the expired lease and reconciles it.
    const restarted = new JsonRouterStore(config.statePath);
    await restarted.init();
    const next = await restarted.beginDelivery(proposal.id, "recovery", 300, new Date(Date.now() + 5_000));
    expect(next.outcome).toBeNull();
    const reconciled = restarted.listDeliveryAttempts(proposal.id).find((attempt) => attempt.id === stuck.id)!;
    expect(reconciled.outcome).toBe("unknown");
    expect(reconciled.error).toContain("lease expired");
  });

  it("blocks recovery when a note body changed but its router metadata still matches", async () => {
    const { app, config } = await securedApp();
    const proposal = await approvedObsidianProposal(app, "edited-retry");
    const detail = await app.inject({ method: "GET", url: `/v1/proposals/${proposal.id}`, headers: auth(REVIEWER_TOKEN) });
    const rendered = renderObsidianMeeting(detail.json().data);
    const edited = `${rendered.markdown}\nA human added this paragraph.\n`;
    await mkdir(config.obsidianOutputRoot, { recursive: true });
    const notePath = join(config.obsidianOutputRoot, rendered.filename);
    await writeFile(notePath, edited, "utf8");

    const delivery = await app.inject({ method: "POST", url: `/v1/proposals/${proposal.id}/deliver`, headers: auth(REVIEWER_TOKEN) });
    expect(delivery.statusCode).toBe(409);
    expect(delivery.json().data.proposal.status).toBe("blocked");
    expect(await readFile(notePath, "utf8")).toBe(edited);
  });
});

describe("retention, deletion, export, and encryption", () => {
  it.each(["delete", "retention"])("preserves an edited delivered note and its meeting on %s", async (operation) => {
    const { app, config } = await securedApp({ MEETING_ROUTER_MEETING_TTL_DAYS: "1" });
    const proposal = await approvedObsidianProposal(app, `edited-${operation}`);
    const delivered = await app.inject({ method: "POST", url: `/v1/proposals/${proposal.id}/deliver`, headers: auth(REVIEWER_TOKEN) });
    expect(delivered.statusCode).toBe(200);
    const detail = await app.inject({ method: "GET", url: `/v1/proposals/${proposal.id}`, headers: auth(REVIEWER_TOKEN) });
    const rendered = renderObsidianMeeting(detail.json().data);
    const notePath = join(config.obsidianOutputRoot, rendered.filename);
    const edited = `${rendered.markdown}\nA human added this paragraph.\n`;
    await writeFile(notePath, edited, "utf8");

    // Only Date is faked; Fastify's request timers continue to run normally.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(Date.now() + 2 * 86_400_000));
    try {
      const response = await app.inject(operation === "delete"
        ? { method: "DELETE", url: `/v1/meetings/${proposal.meetingId}`, headers: auth(ADMIN_TOKEN) }
        : { method: "POST", url: "/v1/retention/sweep", headers: auth(ADMIN_TOKEN), payload: {} });
      expect(response.statusCode).toBe(409);
      expect(response.json().error.code).toBe("artifact_conflict");
      expect(await readFile(notePath, "utf8")).toBe(edited);
      const state = JSON.parse(await readFile(config.statePath, "utf8"));
      expect(state.meetings).toHaveLength(1);
      expect(state.proposals).toHaveLength(2);
      expect(state.deletionLog).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("drops transcripts at ingest by default and keeps them only when opted in", async () => {
    const { app, config } = await securedApp();
    await app.inject({ method: "POST", url: "/v1/intake/agent", headers: auth(MCP_TOKEN), payload: { ...meeting("retain-1"), source: "generic" } });
    const state = JSON.parse(await readFile(config.statePath, "utf8"));
    expect(JSON.stringify(state)).not.toContain("sensitive narrative");

    const { app: retainingApp, config: retainingConfig } = await securedApp({ MEETING_ROUTER_RETAIN_TRANSCRIPTS: "true" });
    await retainingApp.inject({ method: "POST", url: "/v1/intake/agent", headers: auth(MCP_TOKEN), payload: { ...meeting("retain-2"), source: "generic" } });
    expect(await readFile(retainingConfig.statePath, "utf8")).toContain("sensitive narrative");

    // Default meeting reads never include transcript text.
    const meetings = await retainingApp.inject({ method: "GET", url: "/v1/meetings", headers: auth(REVIEWER_TOKEN) });
    expect(JSON.stringify(meetings.json())).not.toContain("sensitive narrative");
    const meetingId = meetings.json().data[0].id as string;
    const detail = await retainingApp.inject({ method: "GET", url: `/v1/meetings/${meetingId}`, headers: auth(REVIEWER_TOKEN) });
    expect(JSON.stringify(detail.json())).not.toContain("sensitive narrative");
    const withTranscript = await retainingApp.inject({ method: "GET", url: `/v1/meetings/${meetingId}?includeTranscript=true`, headers: auth(REVIEWER_TOKEN) });
    expect(JSON.stringify(withTranscript.json())).toContain("sensitive narrative");
  });

  it("deletes a meeting with cascade, artifact cleanup, and content-free evidence", async () => {
    const { app, root, config } = await securedApp();
    const proposal = await approvedObsidianProposal(app, "delete-1");
    await app.inject({ method: "POST", url: `/v1/proposals/${proposal.id}/deliver`, headers: auth(REVIEWER_TOKEN) });

    const dryRun = await app.inject({ method: "DELETE", url: `/v1/meetings/${proposal.meetingId}?dryRun=true`, headers: auth(ADMIN_TOKEN) });
    expect(dryRun.statusCode).toBe(200);
    expect(dryRun.json().data.cascade.proposalIds).toHaveLength(2);

    const deletion = await app.inject({ method: "DELETE", url: `/v1/meetings/${proposal.meetingId}`, headers: auth(ADMIN_TOKEN) });
    expect(deletion.statusCode).toBe(200);
    expect(deletion.json().data.cascade.deliveredArtifacts).toHaveLength(1);

    const state = JSON.parse(await readFile(config.statePath, "utf8"));
    expect(state.meetings).toHaveLength(0);
    expect(state.proposals).toHaveLength(0);
    expect(state.deletionLog).toHaveLength(1);
    expect(JSON.stringify(state.deletionLog)).not.toContain("Security review");
    const artifacts = await app.inject({ method: "GET", url: `/v1/meetings/${proposal.meetingId}`, headers: auth(REVIEWER_TOKEN) });
    expect(artifacts.statusCode).toBe(404);
    void root;
  });

  it("refuses deletion during an active delivery so completion cannot leave an untracked artifact", async () => {
    const { app, config } = await securedApp();
    const proposal = await approvedObsidianProposal(app, "delete-during-delivery");
    await app.close();

    // One store shared by the in-flight delivery and the API, as in production.
    const store = new JsonRouterStore(config.statePath);
    const live = await buildApp(config, store);
    apps.push(live);

    // The delivery has acquired its lease and written the note, but has not yet recorded its result.
    const attempt = await store.beginDelivery(proposal.id, "in-flight", 300);
    const written = await deliverObsidianProposal(store.getProposal(proposal.id), config.obsidianOutputRoot);

    const dryRun = await live.inject({ method: "DELETE", url: `/v1/meetings/${proposal.meetingId}?dryRun=true`, headers: auth(ADMIN_TOKEN) });
    expect(dryRun.statusCode).toBe(409);
    const deletion = await live.inject({ method: "DELETE", url: `/v1/meetings/${proposal.meetingId}`, headers: auth(ADMIN_TOKEN) });
    expect(deletion.statusCode).toBe(409);
    expect(deletion.json().error.message).toContain("delivery in progress");
    await expect(store.deleteMeeting(proposal.meetingId, "direct", [])).rejects.toThrow(/delivery in progress/);
    expect(store.getMeeting(proposal.meetingId).id).toBe(proposal.meetingId);
    expect(await readFile(written.path, "utf8")).toContain("Security review");

    // Completion is still recorded against a tracked proposal.
    const finished = await store.finishDelivery(proposal.id, attempt.id, "delivered", { destinationReceiptId: written.filename });
    expect(finished.status).toBe("delivered");

    // Once the delivery has finished, deletion removes the artifact it now knows about.
    const retry = await live.inject({ method: "DELETE", url: `/v1/meetings/${proposal.meetingId}`, headers: auth(ADMIN_TOKEN) });
    expect(retry.statusCode).toBe(200);
    expect(retry.json().data.cascade.deliveredArtifacts).toEqual([written.filename]);
    await expect(readFile(written.path, "utf8")).rejects.toThrow();
  });

  it("stops a retention sweep at a meeting whose delivery is in progress", async () => {
    const { app, config } = await securedApp({ MEETING_ROUTER_MEETING_TTL_DAYS: "1" });
    const proposal = await approvedObsidianProposal(app, "sweep-during-delivery");
    await app.close();

    const store = new JsonRouterStore(config.statePath);
    const live = await buildApp(config, store);
    apps.push(live);
    await store.beginDelivery(proposal.id, "in-flight", 300);

    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(new Date(Date.now() + 2 * 24 * 60 * 60 * 1_000));
      const sweep = await live.inject({ method: "POST", url: "/v1/retention/sweep", headers: auth(ADMIN_TOKEN), payload: { dryRun: false } });
      expect(sweep.statusCode).toBe(409);
    } finally {
      vi.useRealTimers();
    }
    expect(store.getMeeting(proposal.meetingId).id).toBe(proposal.meetingId);
  });

  it("sweeps expired meetings deterministically when a TTL is configured", async () => {
    const { app } = await securedApp({ MEETING_ROUTER_MEETING_TTL_DAYS: "1" });
    await approvedObsidianProposal(app, "sweep-1");
    const dryRun = await app.inject({ method: "POST", url: "/v1/retention/sweep", headers: auth(ADMIN_TOKEN), payload: { dryRun: true } });
    expect(dryRun.statusCode).toBe(200);
    expect(dryRun.json().data.expiredMeetingIds).toHaveLength(0);
  });

  it("encrypts state at rest and survives key rotation", async () => {
    const key = randomBytes(32).toString("base64");
    const { app, config } = await securedApp({ MEETING_ROUTER_STATE_KEY: key });
    await app.inject({ method: "POST", url: "/v1/intake/agent", headers: auth(MCP_TOKEN), payload: { ...meeting("encrypt-1"), source: "generic" } });
    const onDisk = await readFile(config.statePath, "utf8");
    expect(onDisk).toContain("MCR-ENC-1");
    expect(onDisk).not.toContain("Security review");

    // Rotation: new key with the old one as previous. init() re-encrypts.
    const newKey = randomBytes(32).toString("base64");
    const rotated = new JsonRouterStore(config.statePath, {
      key: Buffer.from(newKey, "base64"),
      previousKey: Buffer.from(key, "base64"),
    });
    await rotated.init();
    const afterRotation = new JsonRouterStore(config.statePath, { key: Buffer.from(newKey, "base64"), previousKey: null });
    await afterRotation.init();
    expect(afterRotation.listMeetingSummaries(10, 0).total).toBe(1);

    // Without any valid key the store refuses to start.
    const locked = new JsonRouterStore(config.statePath);
    await expect(locked.init()).rejects.toThrow(/encrypted/);
  });

  it("migrates schema v1 state files in place", async () => {
    const root = await mkdtemp(join(tmpdir(), "meeting-router-migrate-"));
    const statePath = join(root, "state.json");
    await writeFile(statePath, JSON.stringify({ schemaVersion: 1, meetings: [], proposals: [] }), "utf8");
    const store = new JsonRouterStore(statePath);
    await store.init();
    const migrated = JSON.parse(await readFile(statePath, "utf8"));
    expect(migrated.schemaVersion).toBe(2);
    expect(migrated.deliveryAttempts).toEqual([]);
    expect(migrated.deletionLog).toEqual([]);
  });
});
