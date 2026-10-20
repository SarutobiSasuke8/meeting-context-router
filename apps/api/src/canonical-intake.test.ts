import { mkdtemp, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp, CANONICAL_EVENT_BODY_LIMIT_BYTES } from "./app.js";
import { loadConfig } from "./config.js";

// Synthetic tokens and content only.
const GATEWAY_TOKEN = "gateway-token-0000000000000000000000";
const OTHER_GATEWAY_TOKEN = "gateway-two-token-00000000000000000";
const READER_TOKEN = "reader-token-00000000000000000000000";

const apps: Awaited<ReturnType<typeof buildApp>>[] = [];
afterEach(async () => { await Promise.all(apps.splice(0).map((app) => app.close())); });

async function gatewayApp() {
  const root = await mkdtemp(join(tmpdir(), "meeting-router-canonical-"));
  const config = loadConfig({
    NODE_ENV: "test",
    MEETING_ROUTER_STATE_PATH: join(root, "state.json"),
    OBSIDIAN_OUTPUT_ROOT: join(root, "obsidian"),
    MEETING_ROUTER_PRINCIPALS: JSON.stringify([
      { id: "gateway", type: "service", token: GATEWAY_TOKEN, scopes: ["meeting:ingest"] },
      { id: "gateway-two", type: "service", token: OTHER_GATEWAY_TOKEN, scopes: ["meeting:ingest"] },
      { id: "reader", type: "human", token: READER_TOKEN, scopes: ["meeting:read", "proposal:read"] },
    ]),
  });
  const app = await buildApp(config);
  apps.push(app);
  return { app, root };
}

const auth = (token: string) => ({ authorization: `Bearer ${token}` });

const event = (eventId: string, overrides: Record<string, unknown> = {}) => ({
  eventId,
  meeting: {
    title: "Gateway sync",
    startedAt: "2026-10-20T09:00:00.000Z",
    endedAt: "2026-10-20T09:30:00.000Z",
    participants: [{ name: "Sam", email: "sam@example.com", external: true }],
    summary: "Synthetic gateway summary.",
    actionItems: [{ description: "Send the follow-up", assigneeName: "Sam", assigneeEmail: "sam@example.com", dueOn: null, completed: false, evidenceTimestamp: null }],
    decisions: ["Proceed"],
    transcript: [],
    provenance: { source: "generic", sourceMeetingId: `gw-${eventId}`, sourceUrl: null },
    ...overrides,
  },
});

async function proposals(app: Awaited<ReturnType<typeof buildApp>>) {
  return (await app.inject({ method: "GET", url: "/v1/proposals", headers: auth(READER_TOKEN) })).json().data as Array<{ id: string; status: string; target: string; meetingId: string }>;
}

describe("POST /v1/intake/canonical", () => {
  it("turns a canonical event into pending proposals only, with gateway provenance", async () => {
    const { app, root } = await gatewayApp();
    const response = await app.inject({ method: "POST", url: "/v1/intake/canonical", headers: auth(GATEWAY_TOKEN), payload: event("evt-1") });
    expect(response.statusCode).toBe(202);
    const data = response.json().data;
    expect(data).toMatchObject({ eventId: "evt-1", duplicate: false });
    expect(data.proposalIds).toHaveLength(2);

    const queued = await proposals(app);
    expect(queued.map((proposal) => proposal.status)).toEqual(["pending", "pending"]);
    expect(queued.map((proposal) => proposal.target).sort()).toEqual(["crm", "obsidian"]);

    const meeting = (await app.inject({ method: "GET", url: `/v1/meetings/${data.meetingId}`, headers: auth(READER_TOKEN) })).json().data;
    expect(meeting.provenance).toMatchObject({ source: "generic", transport: "gateway", signatureVerified: false, gateway: { principalId: "gateway", eventId: "evt-1" } });

    // Nothing is written to the Obsidian root during intake.
    await expect(readdir(join(root, "obsidian"))).rejects.toThrow();
  });

  it("is idempotent on event id and rejects a reused id with different content", async () => {
    const { app } = await gatewayApp();
    const first = await app.inject({ method: "POST", url: "/v1/intake/canonical", headers: auth(GATEWAY_TOKEN), payload: event("evt-2") });
    expect(first.statusCode).toBe(202);

    const replay = await app.inject({ method: "POST", url: "/v1/intake/canonical", headers: auth(GATEWAY_TOKEN), payload: event("evt-2") });
    expect(replay.statusCode).toBe(200);
    expect(replay.json().data).toEqual({ ...first.json().data, duplicate: true });
    expect(await proposals(app)).toHaveLength(2);

    const changed = await app.inject({ method: "POST", url: "/v1/intake/canonical", headers: auth(GATEWAY_TOKEN), payload: event("evt-2", { summary: "Different content." }) });
    expect(changed.statusCode).toBe(409);
    expect(changed.json().error.code).toBe("conflict");

    // Same event id but a different source meeting is still a content change.
    const moved = await app.inject({ method: "POST", url: "/v1/intake/canonical", headers: auth(GATEWAY_TOKEN), payload: event("evt-2", { provenance: { source: "generic", sourceMeetingId: "gw-other", sourceUrl: null } }) });
    expect(moved.statusCode).toBe(409);
    expect(await proposals(app)).toHaveLength(2);
  });

  it("namespaces event ids per gateway principal", async () => {
    const { app } = await gatewayApp();
    expect((await app.inject({ method: "POST", url: "/v1/intake/canonical", headers: auth(GATEWAY_TOKEN), payload: event("evt-3") })).statusCode).toBe(202);
    const other = await app.inject({ method: "POST", url: "/v1/intake/canonical", headers: auth(OTHER_GATEWAY_TOKEN), payload: event("evt-3", { provenance: { source: "generic", sourceMeetingId: "gw-two-evt-3", sourceUrl: null } }) });
    expect(other.statusCode).toBe(202);
    expect(await proposals(app)).toHaveLength(4);
  });

  it("falls back to source meeting id dedup across different event ids", async () => {
    const { app } = await gatewayApp();
    const shared = { provenance: { source: "generic", sourceMeetingId: "gw-shared", sourceUrl: null } };
    expect((await app.inject({ method: "POST", url: "/v1/intake/canonical", headers: auth(GATEWAY_TOKEN), payload: event("evt-4a", shared) })).statusCode).toBe(202);
    const same = await app.inject({ method: "POST", url: "/v1/intake/canonical", headers: auth(GATEWAY_TOKEN), payload: event("evt-4b", shared) });
    expect(same.statusCode).toBe(200);
    expect(same.json().data.duplicate).toBe(true);
    const different = await app.inject({ method: "POST", url: "/v1/intake/canonical", headers: auth(GATEWAY_TOKEN), payload: event("evt-4c", { ...shared, summary: "Changed." }) });
    expect(different.statusCode).toBe(409);
  });

  it("rejects unauthenticated and wrong-scope callers before reading the body", async () => {
    const { app } = await gatewayApp();
    const anonymous = await app.inject({ method: "POST", url: "/v1/intake/canonical", payload: event("evt-5") });
    expect(anonymous.statusCode).toBe(401);
    const badToken = await app.inject({ method: "POST", url: "/v1/intake/canonical", headers: auth("not-a-real-token-000000000000000"), payload: event("evt-5") });
    expect(badToken.statusCode).toBe(401);
    const wrongScope = await app.inject({ method: "POST", url: "/v1/intake/canonical", headers: auth(READER_TOKEN), payload: event("evt-5") });
    expect(wrongScope.statusCode).toBe(403);
    expect(wrongScope.json().error.code).toBe("forbidden");
    // An oversize body from a wrong-scope caller is refused on scope, not parsed.
    const wrongScopeOversize = await app.inject({ method: "POST", url: "/v1/intake/canonical", headers: { ...auth(READER_TOKEN), "content-type": "application/json" }, payload: "x".repeat(CANONICAL_EVENT_BODY_LIMIT_BYTES + 1) });
    expect(wrongScopeOversize.statusCode).toBe(403);
    expect(await proposals(app)).toHaveLength(0);
  });

  it("rejects an oversize body with 413", async () => {
    const { app } = await gatewayApp();
    const body = JSON.stringify(event("evt-6", { summary: "a".repeat(CANONICAL_EVENT_BODY_LIMIT_BYTES) }));
    const response = await app.inject({ method: "POST", url: "/v1/intake/canonical", headers: { ...auth(GATEWAY_TOKEN), "content-type": "application/json" }, payload: body });
    expect(response.statusCode).toBe(413);
    expect(response.json().error.code).toBe("payload_too_large");
    expect(await proposals(app)).toHaveLength(0);
  });

  it("rejects malformed and non-canonical payloads without persisting anything", async () => {
    const { app } = await gatewayApp();
    const malformedJson = await app.inject({ method: "POST", url: "/v1/intake/canonical", headers: { ...auth(GATEWAY_TOKEN), "content-type": "application/json" }, payload: "{\"eventId\":" });
    expect(malformedJson.statusCode).toBe(400);
    expect(malformedJson.json().error.code).toBe("invalid_body");

    const base = event("evt-7");
    const invalid: Array<[string, unknown]> = [
      ["missing eventId", { meeting: base.meeting }],
      ["bad eventId characters", { ...base, eventId: "evt 7/../" }],
      ["unknown top-level field", { ...base, extra: true }],
      ["router-owned meeting id", { ...base, meeting: { ...base.meeting, id: "6a3c9dfd-98a1-4c25-9a26-2fc4bb2e6f11" } }],
      ["caller-asserted signature", { ...base, meeting: { ...base.meeting, provenance: { ...base.meeting.provenance, signatureVerified: true } } }],
      ["caller-supplied hash", { ...base, meeting: { ...base.meeting, provenance: { ...base.meeting.provenance, sourceHash: "a".repeat(64) } } }],
      ["manual source", { ...base, meeting: { ...base.meeting, provenance: { ...base.meeting.provenance, source: "manual" } } }],
      ["unknown source", { ...base, meeting: { ...base.meeting, provenance: { ...base.meeting.provenance, source: "zoom" } } }],
      ["unknown participant field", { ...base, meeting: { ...base.meeting, participants: [{ name: "Sam", email: null, external: null, phone: "1" }] } }],
      ["missing participant fields", { ...base, meeting: { ...base.meeting, participants: [{ name: "Sam" }] } }],
      ["bad startedAt", { ...base, meeting: { ...base.meeting, startedAt: "yesterday" } }],
      ["bad email", { ...base, meeting: { ...base.meeting, participants: [{ name: "Sam", email: "not-an-email", external: null }] } }],
      ["array body", [base]],
    ];
    for (const [label, payload] of invalid) {
      const response = await app.inject({ method: "POST", url: "/v1/intake/canonical", headers: auth(GATEWAY_TOKEN), payload: payload as object });
      expect(response.statusCode, label).toBe(422);
      expect(response.json().error.code, label).toBe("validation_error");
    }
    expect(await proposals(app)).toHaveLength(0);
  });

  it("respects source capability manifests", async () => {
    const { app } = await gatewayApp();
    // Granola does not declare actionItems, so routing them is refused.
    const response = await app.inject({ method: "POST", url: "/v1/intake/canonical", headers: auth(GATEWAY_TOKEN), payload: event("evt-8", { provenance: { source: "granola", sourceMeetingId: "gw-granola", sourceUrl: null } }) });
    expect(response.statusCode).toBe(422);
    expect(response.json().error.code).toBe("unsupported_route");
    expect(await proposals(app)).toHaveLength(0);
    const supported = await app.inject({ method: "POST", url: "/v1/intake/canonical", headers: auth(GATEWAY_TOKEN), payload: event("evt-8", { actionItems: [], provenance: { source: "granola", sourceMeetingId: "gw-granola", sourceUrl: null } }) });
    expect(supported.statusCode).toBe(202);
  });
});
