/**
 * Router to generic outbound webhook, end to end, against a local fake
 * receiver only (node:http on a random 127.0.0.1 port). No third-party
 * endpoint is contacted. The receiver verifies the HMAC signature and dedupes
 * on the webhook id, as the README asks real consumers to do.
 */
import { randomBytes } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { createServer, type IncomingHttpHeaders, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { RoutingProposal } from "@meeting-context-router/core";
import { OUTBOUND_WEBHOOK_HEADERS, verifyOutboundWebhookSignature } from "@meeting-context-router/destination-webhook";
import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";

interface Received { headers: IncomingHttpHeaders; body: string; verified: boolean }

const apps: Awaited<ReturnType<typeof buildApp>>[] = [];
const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); })));
});

/**
 * Deduplicating fake consumer. `behaviour(n)` picks the answer for the n-th
 * request: a status code, or "hang" to accept the event and never answer
 * (the router times out while the consumer holds the event).
 */
async function fakeConsumer(secret: string, behaviour: (requestNumber: number) => number | "hang" = () => 200) {
  const received: Received[] = [];
  const committed = new Map<string, string>();
  const server = createServer((request, response: ServerResponse) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      const verified = verifyOutboundWebhookSignature(secret, {
        timestamp: request.headers[OUTBOUND_WEBHOOK_HEADERS.timestamp] as string | undefined,
        signature: request.headers[OUTBOUND_WEBHOOK_HEADERS.signature] as string | undefined,
      }, body);
      received.push({ headers: request.headers, body, verified });
      if (!verified) { response.writeHead(401); response.end(); return; }
      const id = request.headers[OUTBOUND_WEBHOOK_HEADERS.id] as string;
      if (!committed.has(id)) committed.set(id, body);
      const answer = behaviour(received.length);
      if (answer === "hang") return;
      response.writeHead(answer, { "content-type": "application/json" });
      response.end(JSON.stringify({ id: `consumer-${id.slice(0, 8)}` }));
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/webhook/meeting-router`, received, committed };
}

async function routerApp(environment: Record<string, string> = {}) {
  const root = await mkdtemp(join(tmpdir(), "router-webhook-"));
  const config = loadConfig({ NODE_ENV: "test", MEETING_ROUTER_STATE_PATH: join(root, "state.json"), OBSIDIAN_OUTPUT_ROOT: join(root, "notes"), ...environment });
  const app = await buildApp(config);
  apps.push(app);
  return app;
}

const meeting = {
  source: "generic",
  sourceMeetingId: "webhook-synthetic-001",
  title: "Synthetic webhook meeting",
  startedAt: "2026-10-20T09:00:00.000Z",
  endedAt: "2026-10-20T09:30:00.000Z",
  participants: [{ name: "Example Host", email: "host@example.com", external: false }],
  summary: "Synthetic summary. Contains no real meeting content.",
  actionItems: [{ description: "Wire the n8n flow", assigneeName: "Example Host" }],
  decisions: ["Use one generic outbound webhook"],
  transcript: [{ speaker: "Example Host", text: "This transcript line must never leave the router." }],
};

async function webhookProposal(app: Awaited<ReturnType<typeof buildApp>>, sourceMeetingId = meeting.sourceMeetingId) {
  expect((await app.inject({ method: "POST", url: "/v1/intake/agent", payload: { ...meeting, sourceMeetingId } })).statusCode).toBe(202);
  const proposals = (await app.inject({ method: "GET", url: "/v1/proposals" })).json().data as RoutingProposal[];
  return proposals.find((proposal) => proposal.target === "webhook" && proposal.payload.sourceMeetingId === sourceMeetingId)!;
}

const webhookEnvironment = (url: string, secret: string, extra: Record<string, string> = {}) => ({
  OUTBOUND_WEBHOOK_URL: url, OUTBOUND_WEBHOOK_SECRET: secret, OUTBOUND_WEBHOOK_BACKOFF_MS: "0", OUTBOUND_WEBHOOK_BACKOFF_MAX_MS: "0", ...extra,
});

describe("outbound webhook delivery through the router", () => {
  it("creates no webhook proposal when the webhook is not configured", async () => {
    const app = await routerApp();
    await app.inject({ method: "POST", url: "/v1/intake/agent", payload: meeting });
    const proposals = (await app.inject({ method: "GET", url: "/v1/proposals" })).json().data as RoutingProposal[];
    expect(proposals.map((proposal) => proposal.target).sort()).toEqual(["crm", "obsidian"]);
  });

  it("declares the webhook destination in capability discovery", async () => {
    const app = await routerApp();
    const capabilities = (await app.inject({ method: "GET", url: "/v1/capabilities" })).json().data;
    expect(capabilities.destinations.webhook).toEqual(expect.objectContaining({ id: "webhook", direction: "destination" }));
    expect(capabilities.destinations.webhook.supports).toEqual(expect.objectContaining({ webhooks: true, transcript: false, replaySafeIds: true }));
  });

  it("fires only after approval, once, and a replay never double-delivers", async () => {
    const secret = randomBytes(32).toString("hex");
    const consumer = await fakeConsumer(secret);
    const app = await routerApp(webhookEnvironment(consumer.url, secret));
    const proposal = await webhookProposal(app);
    expect(proposal.status).toBe("pending");
    expect(proposal.payload).not.toHaveProperty("transcript");

    const early = await app.inject({ method: "POST", url: `/v1/proposals/${proposal.id}/deliver` });
    expect(early.statusCode).toBe(409);
    expect(consumer.received).toHaveLength(0);

    expect((await app.inject({ method: "POST", url: `/v1/proposals/${proposal.id}/approve` })).statusCode).toBe(200);
    const delivered = await app.inject({ method: "POST", url: `/v1/proposals/${proposal.id}/deliver` });
    expect(delivered.statusCode).toBe(200);
    expect(delivered.json().data).toEqual(expect.objectContaining({ destinationStatus: 200, httpAttempts: 1, destinationReceiptId: `consumer-${proposal.idempotencyKey.slice(0, 8)}` }));
    expect(delivered.json().data.proposal.status).toBe("delivered");
    expect(consumer.received).toHaveLength(1);
    expect(consumer.received[0]!.verified).toBe(true);
    expect(consumer.received[0]!.headers[OUTBOUND_WEBHOOK_HEADERS.id]).toBe(proposal.idempotencyKey);
    expect(consumer.received[0]!.body).not.toContain("must never leave the router");
    expect(consumer.received[0]!.body).not.toContain(secret);

    const replay = await app.inject({ method: "POST", url: `/v1/proposals/${proposal.id}/deliver` });
    expect(replay.statusCode).toBe(409);
    expect(consumer.received).toHaveLength(1);
    expect(consumer.committed.size).toBe(1);
    const attempts = (await app.inject({ method: "GET", url: `/v1/proposals/${proposal.id}/attempts` })).json().data;
    expect(attempts).toHaveLength(1);
    expect(attempts[0]).toEqual(expect.objectContaining({ outcome: "delivered", destinationStatus: 200, idempotencyKey: proposal.idempotencyKey }));
  });

  it("never fires on a rejected proposal", async () => {
    const secret = randomBytes(32).toString("hex");
    const consumer = await fakeConsumer(secret);
    const app = await routerApp(webhookEnvironment(consumer.url, secret));
    const proposal = await webhookProposal(app);
    expect((await app.inject({ method: "POST", url: `/v1/proposals/${proposal.id}/reject` })).statusCode).toBe(200);
    expect((await app.inject({ method: "POST", url: `/v1/proposals/${proposal.id}/deliver` })).statusCode).toBe(409);
    expect(consumer.received).toHaveLength(0);
  });

  it("retries a transient consumer failure inside one delivery and keeps one copy", async () => {
    const secret = randomBytes(32).toString("hex");
    // First answer: the consumer committed the event but answered 503.
    const consumer = await fakeConsumer(secret, (n) => (n === 1 ? 503 : 200));
    const app = await routerApp(webhookEnvironment(consumer.url, secret));
    const proposal = await webhookProposal(app);
    await app.inject({ method: "POST", url: `/v1/proposals/${proposal.id}/approve` });
    const delivered = await app.inject({ method: "POST", url: `/v1/proposals/${proposal.id}/deliver` });
    expect(delivered.statusCode).toBe(200);
    expect(delivered.json().data.httpAttempts).toBe(2);
    expect(consumer.received).toHaveLength(2);
    expect(consumer.received.every((entry) => entry.verified)).toBe(true);
    expect(consumer.committed.size).toBe(1);
  });

  it("records a timed-out delivery as unknown and reconciles it with the same id", async () => {
    const secret = randomBytes(32).toString("hex");
    const consumer = await fakeConsumer(secret, (n) => (n === 1 ? "hang" : 200));
    const app = await routerApp(webhookEnvironment(consumer.url, secret, { OUTBOUND_WEBHOOK_TIMEOUT_MS: "150", OUTBOUND_WEBHOOK_MAX_ATTEMPTS: "1" }));
    const proposal = await webhookProposal(app);
    await app.inject({ method: "POST", url: `/v1/proposals/${proposal.id}/approve` });

    const ambiguous = await app.inject({ method: "POST", url: `/v1/proposals/${proposal.id}/deliver` });
    expect(ambiguous.statusCode).toBe(502);
    expect(ambiguous.json().error.code).toBe("delivery_unknown");
    expect(ambiguous.json().data.proposal.status).toBe("unknown");
    const deadLetter = (await app.inject({ method: "GET", url: "/v1/deliveries/dead-letter" })).json().data;
    expect(deadLetter.map((entry: { proposal: RoutingProposal }) => entry.proposal.id)).toContain(proposal.id);

    const reconciled = await app.inject({ method: "POST", url: `/v1/proposals/${proposal.id}/deliver` });
    expect(reconciled.statusCode).toBe(200);
    expect(consumer.received).toHaveLength(2);
    expect(new Set(consumer.received.map((entry) => entry.headers[OUTBOUND_WEBHOOK_HEADERS.id]))).toEqual(new Set([proposal.idempotencyKey]));
    expect(new Set(consumer.received.map((entry) => entry.body)).size).toBe(1);
    expect(consumer.committed.size).toBe(1);
  });

  it("blocks for an operator when the consumer refuses the event", async () => {
    const secret = randomBytes(32).toString("hex");
    const consumer = await fakeConsumer(secret, () => 410);
    const app = await routerApp(webhookEnvironment(consumer.url, secret));
    const proposal = await webhookProposal(app);
    await app.inject({ method: "POST", url: `/v1/proposals/${proposal.id}/approve` });
    const blocked = await app.inject({ method: "POST", url: `/v1/proposals/${proposal.id}/deliver` });
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json().error.code).toBe("destination_blocked");
    expect(blocked.json().data.proposal.status).toBe("blocked");
    expect(consumer.received).toHaveLength(1);
  });

  it("records a failed delivery when transient failures outlast the retry budget", async () => {
    const secret = randomBytes(32).toString("hex");
    const consumer = await fakeConsumer(secret, () => 500);
    const app = await routerApp(webhookEnvironment(consumer.url, secret, { OUTBOUND_WEBHOOK_MAX_ATTEMPTS: "2" }));
    const proposal = await webhookProposal(app);
    await app.inject({ method: "POST", url: `/v1/proposals/${proposal.id}/approve` });
    const failed = await app.inject({ method: "POST", url: `/v1/proposals/${proposal.id}/deliver` });
    expect(failed.statusCode).toBe(502);
    expect(failed.json().error.code).toBe("delivery_failed");
    expect((await app.inject({ method: "GET", url: `/v1/proposals/${proposal.id}` })).json().data.status).toBe("failed");
    expect(consumer.received).toHaveLength(2);
  });

  it("refuses unsafe or incomplete webhook configuration at startup", async () => {
    const secret = randomBytes(32).toString("hex");
    expect(() => loadConfig({ NODE_ENV: "test", OUTBOUND_WEBHOOK_URL: "https://consumer.example/hook" })).toThrow(/requires OUTBOUND_WEBHOOK_SECRET/);
    expect(() => loadConfig({ NODE_ENV: "test", OUTBOUND_WEBHOOK_SECRET: secret })).toThrow(/without OUTBOUND_WEBHOOK_URL/);
    expect(() => loadConfig({ NODE_ENV: "test", OUTBOUND_WEBHOOK_URL: "https://consumer.example/hook", OUTBOUND_WEBHOOK_SECRET: "too-short" })).toThrow();
    await expect(routerApp({ OUTBOUND_WEBHOOK_URL: "http://consumer.example/hook", OUTBOUND_WEBHOOK_SECRET: secret })).rejects.toThrow(/must use https/);
    await expect(routerApp({ OUTBOUND_WEBHOOK_URL: "https://consumer.example/hook", OUTBOUND_WEBHOOK_SECRET: secret, OUTBOUND_WEBHOOK_TIMEOUT_MS: "30000", OUTBOUND_WEBHOOK_MAX_ATTEMPTS: "5", MEETING_ROUTER_DELIVERY_LEASE_SECONDS: "60" }))
      .rejects.toThrow(/retry budget exceeds/);
  });
});
