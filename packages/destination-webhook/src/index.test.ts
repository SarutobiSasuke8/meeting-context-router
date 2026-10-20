import { randomBytes } from "node:crypto";
import { createServer, type IncomingHttpHeaders, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import type { RoutingProposal } from "@meeting-context-router/core";
import {
  buildOutboundWebhookEvent,
  deliverOutboundWebhook,
  OUTBOUND_WEBHOOK_EVENT_TYPE,
  OUTBOUND_WEBHOOK_HEADERS,
  OutboundWebhookAmbiguousError,
  OutboundWebhookBlockedError,
  OutboundWebhookConfigurationError,
  OutboundWebhookRejectedError,
  outboundWebhookWorstCaseMs,
  signOutboundWebhook,
  validateOutboundWebhookConfig,
  verifyOutboundWebhookSignature,
} from "./index.js";

// The exact shape core's createRoutingProposals stores for a webhook proposal.
const payload = {
  meetingId: "5d98fdcf-e1e3-4894-b594-142b5bd6e49a",
  source: "fireflies",
  sourceMeetingId: "ff-meeting-001",
  title: "Synthetic partner sync",
  startedAt: "2026-08-27T09:00:00.000Z",
  endedAt: "2026-08-27T09:45:00.000Z",
  sourceUrl: null,
  participants: [{ name: "Example Host", email: "host@example.com", external: false }],
  summary: "Synthetic summary for the outbound webhook contract.",
  actionItems: [{ description: "Send the synthetic follow-up", assigneeName: "Example Host", assigneeEmail: null, dueOn: null, completed: false, evidenceTimestamp: null }],
  decisions: ["Keep every update proposal-first"],
  transcriptIncluded: false,
};

const approved = {
  id: "09d31134-e73e-43f8-a55f-67157927ec1b",
  meetingId: payload.meetingId,
  target: "webhook",
  operation: "deliver_approved_meeting",
  payload,
  evidence: ["fireflies:ff-meeting-001"], confidence: 0.8, status: "delivering",
  idempotencyKey: "b".repeat(64), createdAt: "2026-08-12T09:00:00.000Z",
  reviewedAt: "2026-08-12T09:01:00.000Z", deliveredAt: null, lastError: null,
} satisfies RoutingProposal;

interface Received { headers: IncomingHttpHeaders; body: string }
type Handler = (request: Received, response: ServerResponse) => void;

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); })));
});

/** Local fake receiver on a random loopback port. Never a third-party endpoint. */
async function fakeReceiver(handler: Handler): Promise<{ url: string; received: Received[] }> {
  const received: Received[] = [];
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const entry = { headers: request.headers, body: Buffer.concat(chunks).toString("utf8") };
      received.push(entry);
      handler(entry, response);
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/hooks/meeting-router`, received };
}

const reply = (response: ServerResponse, status: number, body: unknown = {}, headers: Record<string, string> = {}) => {
  response.writeHead(status, { "content-type": "application/json", ...headers });
  response.end(JSON.stringify(body));
};
const header = (entry: Received, name: string) => entry.headers[name] as string | undefined;
const noSleep = { sleep: async () => undefined };

describe("outbound webhook destination", () => {
  it("posts one HMAC-signed event that the receiver can verify", async () => {
    const secret = randomBytes(32).toString("hex");
    const receiver = await fakeReceiver((_request, response) => reply(response, 202, { id: "receipt-1" }));
    const result = await deliverOutboundWebhook(approved, { url: receiver.url, secret });
    expect(result).toEqual({ status: 202, receiptId: "receipt-1", attempts: 1 });
    expect(receiver.received).toHaveLength(1);
    const [entry] = receiver.received;
    expect(header(entry!, OUTBOUND_WEBHOOK_HEADERS.id)).toBe(approved.idempotencyKey);
    expect(header(entry!, OUTBOUND_WEBHOOK_HEADERS.idempotencyKey)).toBe(approved.idempotencyKey);
    expect(header(entry!, OUTBOUND_WEBHOOK_HEADERS.attempt)).toBe("1");
    expect(header(entry!, OUTBOUND_WEBHOOK_HEADERS.signature)).toMatch(/^v1=[a-f0-9]{64}$/);
    expect(verifyOutboundWebhookSignature(secret, {
      timestamp: header(entry!, OUTBOUND_WEBHOOK_HEADERS.timestamp),
      signature: header(entry!, OUTBOUND_WEBHOOK_HEADERS.signature),
    }, entry!.body)).toBe(true);
    const event = JSON.parse(entry!.body);
    expect(event).toEqual({ type: OUTBOUND_WEBHOOK_EVENT_TYPE, version: 1, id: approved.idempotencyKey, proposalId: approved.id, meetingId: approved.meetingId, approvedAt: approved.reviewedAt, data: payload });
    expect(entry!.body).not.toContain("transcript\":[");
    expect(entry!.headers.authorization).toBeUndefined();
  });

  it("rejects tampered bodies, wrong secrets, stale timestamps and malformed headers", () => {
    const secret = randomBytes(32).toString("hex");
    const { body } = buildOutboundWebhookEvent(approved);
    const now = new Date("2026-10-21T12:00:00.000Z");
    const timestamp = String(Math.floor(now.getTime() / 1_000));
    const signature = signOutboundWebhook(secret, timestamp, body);
    expect(verifyOutboundWebhookSignature(secret, { timestamp, signature }, body, now)).toBe(true);
    expect(verifyOutboundWebhookSignature(secret, { timestamp, signature: `v1=${"0".repeat(64)} ${signature}` }, body, now)).toBe(true);
    expect(verifyOutboundWebhookSignature(secret, { timestamp, signature }, body.replace("Synthetic", "Tampered"), now)).toBe(false);
    expect(verifyOutboundWebhookSignature(randomBytes(32).toString("hex"), { timestamp, signature }, body, now)).toBe(false);
    expect(verifyOutboundWebhookSignature(secret, { timestamp, signature }, body, new Date(now.getTime() + 301_000))).toBe(false);
    expect(verifyOutboundWebhookSignature(secret, { timestamp: String(Number(timestamp) + 1), signature }, body, now)).toBe(false);
    expect(verifyOutboundWebhookSignature(secret, { timestamp: "not-a-number", signature }, body, now)).toBe(false);
    expect(verifyOutboundWebhookSignature(secret, { timestamp, signature: undefined }, body, now)).toBe(false);
  });

  it("fires only on approved proposals and sends nothing otherwise", async () => {
    const secret = randomBytes(32).toString("hex");
    const receiver = await fakeReceiver((_request, response) => reply(response, 200));
    for (const proposal of [
      { ...approved, status: "pending", reviewedAt: null },
      { ...approved, status: "rejected" },
      { ...approved, status: "approved", reviewedAt: null },
      { ...approved, target: "crm", operation: "create_meeting_activity" },
    ] as RoutingProposal[]) {
      await expect(deliverOutboundWebhook(proposal, { url: receiver.url, secret })).rejects.toBeInstanceOf(OutboundWebhookBlockedError);
    }
    await expect(deliverOutboundWebhook({ ...approved, status: "approved" }, { url: receiver.url, secret })).resolves.toEqual(expect.objectContaining({ status: 200 }));
    expect(receiver.received).toHaveLength(1);
  });

  it("blocks a payload outside the contract, including a transcript, before any request", async () => {
    const secret = randomBytes(32).toString("hex");
    const receiver = await fakeReceiver((_request, response) => reply(response, 200));
    await expect(deliverOutboundWebhook({ ...approved, payload: { ...payload, transcript: [{ text: "secret line" }] } }, { url: receiver.url, secret }))
      .rejects.toThrow(/fields: transcript/);
    await expect(deliverOutboundWebhook({ ...approved, payload: { ...payload, transcriptIncluded: true } }, { url: receiver.url, secret }))
      .rejects.toThrow(/fields: transcriptIncluded/);
    expect(receiver.received).toHaveLength(0);
  });

  it("retries transient answers with exponential backoff and the same id and body", async () => {
    const secret = randomBytes(32).toString("hex");
    let calls = 0;
    const receiver = await fakeReceiver((_request, response) => {
      calls += 1;
      if (calls === 1) return reply(response, 503);
      if (calls === 2) return reply(response, 429);
      return reply(response, 200);
    });
    const delays: number[] = [];
    let clock = Date.parse("2026-10-21T12:00:00.000Z");
    const result = await deliverOutboundWebhook(approved, { url: receiver.url, secret, maxAttempts: 3, backoffBaseMs: 1_000, backoffMaxMs: 30_000 }, {
      sleep: async (ms) => { delays.push(ms); clock += ms; },
      random: () => 1,
      now: () => new Date(clock),
    });
    expect(result.attempts).toBe(3);
    expect(delays).toEqual([1_000, 2_000]);
    expect(receiver.received.map((entry) => header(entry, OUTBOUND_WEBHOOK_HEADERS.attempt))).toEqual(["1", "2", "3"]);
    expect(new Set(receiver.received.map((entry) => header(entry, OUTBOUND_WEBHOOK_HEADERS.id)))).toEqual(new Set([approved.idempotencyKey]));
    expect(new Set(receiver.received.map((entry) => entry.body)).size).toBe(1);
    // Each attempt is re-signed with its own timestamp, and each signature verifies.
    expect(new Set(receiver.received.map((entry) => header(entry, OUTBOUND_WEBHOOK_HEADERS.timestamp))).size).toBe(3);
    for (const entry of receiver.received) {
      expect(verifyOutboundWebhookSignature(secret, { timestamp: header(entry, OUTBOUND_WEBHOOK_HEADERS.timestamp), signature: header(entry, OUTBOUND_WEBHOOK_HEADERS.signature) }, entry.body, new Date(clock))).toBe(true);
    }
  });

  it("honours Retry-After up to the backoff ceiling", async () => {
    let calls = 0;
    const receiver = await fakeReceiver((_request, response) => {
      calls += 1;
      if (calls === 1) return reply(response, 429, {}, { "retry-after": "120" });
      return reply(response, 200);
    });
    const delays: number[] = [];
    await deliverOutboundWebhook(approved, { url: receiver.url, secret: randomBytes(32).toString("hex"), backoffBaseMs: 100, backoffMaxMs: 5_000 }, { sleep: async (ms) => { delays.push(ms); }, random: () => 0 });
    expect(delays).toEqual([5_000]);
  });

  it("does not retry a final rejection and marks it non-retryable", async () => {
    const receiver = await fakeReceiver((_request, response) => reply(response, 400));
    const error = await deliverOutboundWebhook(approved, { url: receiver.url, secret: randomBytes(32).toString("hex") }, noSleep).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(OutboundWebhookRejectedError);
    expect(error).toEqual(expect.objectContaining({ status: 400, retryable: false, attempts: 1 }));
    expect(receiver.received).toHaveLength(1);
  });

  it("reports a retryable rejection once the retry budget is spent", async () => {
    const receiver = await fakeReceiver((_request, response) => reply(response, 500));
    const error = await deliverOutboundWebhook(approved, { url: receiver.url, secret: randomBytes(32).toString("hex"), maxAttempts: 3 }, noSleep).catch((caught: unknown) => caught);
    expect(error).toEqual(expect.objectContaining({ name: "OutboundWebhookRejectedError", status: 500, retryable: true, attempts: 3 }));
    expect(receiver.received).toHaveLength(3);
  });

  it("reports an ambiguous outcome when an attempt timed out and none succeeded", async () => {
    // The receiver accepts the event and never answers: it may hold the event.
    const receiver = await fakeReceiver(() => undefined);
    const error = await deliverOutboundWebhook(approved, { url: receiver.url, secret: randomBytes(32).toString("hex"), timeoutMs: 150, maxAttempts: 2 }, noSleep).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(OutboundWebhookAmbiguousError);
    expect(receiver.received).toHaveLength(2);
    expect(new Set(receiver.received.map((entry) => header(entry, OUTBOUND_WEBHOOK_HEADERS.id))).size).toBe(1);
  });

  it("refuses redirects instead of following them to another host", async () => {
    const target = await fakeReceiver((_request, response) => reply(response, 200));
    const redirector = await fakeReceiver((_request, response) => { response.writeHead(307, { location: target.url }); response.end(); });
    await expect(deliverOutboundWebhook(approved, { url: redirector.url, secret: randomBytes(32).toString("hex") }, noSleep))
      .rejects.toEqual(expect.objectContaining({ name: "OutboundWebhookRejectedError", status: 307, retryable: false }));
    expect(redirector.received).toHaveLength(1);
    expect(target.received).toHaveLength(0);
  });

  it("validates the configured URL and secret and blocks before any request", async () => {
    const secret = randomBytes(32).toString("hex");
    for (const url of ["not a url", "ftp://127.0.0.1/hook", "http://consumer.example/hook", "https://user:pass@consumer.example/hook", "https://consumer.example/hook#frag"]) {
      expect(() => validateOutboundWebhookConfig({ url, secret })).toThrow(OutboundWebhookConfigurationError);
      await expect(deliverOutboundWebhook({ ...approved }, { url, secret })).rejects.toBeInstanceOf(OutboundWebhookBlockedError);
    }
    expect(() => validateOutboundWebhookConfig({ url: "https://consumer.example/hook", secret: "short" })).toThrow(/at least 32/);
    expect(validateOutboundWebhookConfig({ url: "https://consumer.example/webhook/abc?route=meetings", secret }).hostname).toBe("consumer.example");
    expect(validateOutboundWebhookConfig({ url: "http://localhost:5678/webhook/abc", secret }).port).toBe("5678");
  });

  it("computes a worst-case duration bounded by the backoff ceiling", () => {
    expect(outboundWebhookWorstCaseMs({ url: "https://consumer.example", secret: "x", timeoutMs: 10_000, maxAttempts: 3, backoffMaxMs: 30_000 })).toBe(90_000);
    expect(outboundWebhookWorstCaseMs({ url: "https://consumer.example", secret: "x", maxAttempts: 1 })).toBe(10_000);
  });
});
