import { createHmac, timingSafeEqual } from "node:crypto";
import type { RoutingProposal } from "@meeting-context-router/core";
import { z } from "zod";

/**
 * Generic outbound webhook destination: one signed HTTP POST per approved
 * proposal, for n8n, Zapier or a custom consumer. The URL and secret are
 * administrator configuration and never come from a meeting payload.
 */
export const OUTBOUND_WEBHOOK_EVENT_TYPE = "meeting.proposal.approved";
export const OUTBOUND_WEBHOOK_EVENT_VERSION = 1;

/** Header names, lower case as Node delivers them to a receiver. */
export const OUTBOUND_WEBHOOK_HEADERS = {
  /** Stable per proposal: the proposal idempotency key. Identical on every retry and replay. */
  id: "x-mcr-webhook-id",
  /** Unix seconds at send time. Signed, so a receiver can reject stale requests. */
  timestamp: "x-mcr-webhook-timestamp",
  /** `v1=<hex HMAC-SHA256(secret, "<timestamp>.<raw body>")>`. */
  signature: "x-mcr-webhook-signature",
  /** 1-based attempt number inside one delivery call. Informational, not signed. */
  attempt: "x-mcr-webhook-attempt",
  /** Same value as the webhook id, for consumers that dedupe on the conventional header. */
  idempotencyKey: "idempotency-key",
} as const;

export const DEFAULT_OUTBOUND_WEBHOOK_TOLERANCE_SECONDS = 300;
export const MIN_OUTBOUND_WEBHOOK_SECRET_LENGTH = 32;

export interface OutboundWebhookConfig {
  url: string;
  secret: string;
  timeoutMs?: number;
  /** Total HTTP attempts per delivery call, including the first. */
  maxAttempts?: number;
  /** Base delay of the exponential backoff between attempts. */
  backoffBaseMs?: number;
  /** Ceiling for one backoff delay, including a honoured Retry-After. */
  backoffMaxMs?: number;
}

export interface OutboundWebhookDependencies {
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
}

export const DEFAULT_OUTBOUND_WEBHOOK_RETRY = { timeoutMs: 10_000, maxAttempts: 3, backoffBaseMs: 1_000, backoffMaxMs: 30_000 } as const;

/** Worst-case wall time of one delivery call, used to keep it inside the delivery lease. */
export function outboundWebhookWorstCaseMs(config: OutboundWebhookConfig): number {
  const { timeoutMs, maxAttempts, backoffMaxMs } = { ...DEFAULT_OUTBOUND_WEBHOOK_RETRY, ...definedOnly(config) };
  // Every delay, including a honoured Retry-After, is capped at backoffMaxMs.
  return timeoutMs * maxAttempts + (maxAttempts - 1) * backoffMaxMs;
}

function definedOnly<T extends object>(value: T): Partial<T> {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as Partial<T>;
}

export class OutboundWebhookConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OutboundWebhookConfigurationError";
  }
}

/** Nothing was sent: the proposal or configuration cannot be delivered as is. */
export class OutboundWebhookBlockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OutboundWebhookBlockedError";
  }
}

/**
 * The consumer answered with a non-success status on the final attempt.
 * `retryable` marks transient answers (408, 429, 5xx) that the retry budget
 * ran out on; any other status is final and is recorded as `blocked`.
 */
export class OutboundWebhookRejectedError extends Error {
  readonly status: number;
  readonly retryable: boolean;
  readonly attempts: number;

  constructor(status: number, attempts: number) {
    const retryable = isRetryableStatus(status);
    super(`Webhook consumer answered HTTP ${status} after ${attempts} attempt(s)${retryable ? "; retry later with the same idempotency key" : "; the consumer refused the event, an operator must check the consumer"}`);
    this.name = "OutboundWebhookRejectedError";
    this.status = status;
    this.retryable = retryable;
    this.attempts = attempts;
  }
}

/**
 * At least one attempt timed out or failed mid-flight and none succeeded, so
 * the consumer may hold the event. Record `unknown` and reconcile by
 * delivering again: the id header is unchanged, so a deduplicating consumer
 * keeps one copy.
 */
export class OutboundWebhookAmbiguousError extends Error {
  readonly attempts: number;

  constructor(attempts: number) {
    super(`Webhook delivery timed out or failed mid-flight after ${attempts} attempt(s); the consumer may have received it`);
    this.name = "OutboundWebhookAmbiguousError";
    this.attempts = attempts;
  }
}

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

/**
 * Validates the configured consumer URL once. HTTP(S) only, https unless the
 * host is loopback, no embedded credentials and no fragment. A query string is
 * allowed because some consumers route on it; it is configuration, so it is
 * treated as secret-adjacent and never logged by the router.
 */
export function validateOutboundWebhookUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new OutboundWebhookConfigurationError("OUTBOUND_WEBHOOK_URL is not a valid URL");
  }
  if (!new Set(["http:", "https:"]).has(url.protocol)) throw new OutboundWebhookConfigurationError("OUTBOUND_WEBHOOK_URL must use http or https");
  if (url.username || url.password) throw new OutboundWebhookConfigurationError("OUTBOUND_WEBHOOK_URL must not contain embedded credentials");
  if (url.hash) throw new OutboundWebhookConfigurationError("OUTBOUND_WEBHOOK_URL must not contain a fragment");
  if (url.protocol !== "https:" && !LOOPBACK_HOSTS.has(url.hostname)) throw new OutboundWebhookConfigurationError("Non-loopback OUTBOUND_WEBHOOK_URL must use https");
  return url;
}

export function validateOutboundWebhookConfig(config: OutboundWebhookConfig): URL {
  const url = validateOutboundWebhookUrl(config.url);
  if (config.secret.length < MIN_OUTBOUND_WEBHOOK_SECRET_LENGTH) {
    throw new OutboundWebhookConfigurationError(`OUTBOUND_WEBHOOK_SECRET must be at least ${MIN_OUTBOUND_WEBHOOK_SECRET_LENGTH} characters`);
  }
  return url;
}

/** The approved proposal payload as core's createRoutingProposals stores it. Strict: unknown fields block. */
export const outboundWebhookPayloadSchema = z.object({
  meetingId: z.uuid(),
  source: z.string().trim().min(1).max(80),
  sourceMeetingId: z.string().trim().min(1).max(500),
  title: z.string().trim().min(1).max(500),
  startedAt: z.iso.datetime(),
  endedAt: z.iso.datetime().nullable(),
  sourceUrl: z.url().max(2_000).nullable(),
  participants: z.array(z.object({
    name: z.string().trim().min(1).max(200),
    email: z.email().max(320).nullable(),
    external: z.boolean().nullable(),
  }).strict()).max(250),
  summary: z.string().trim().max(50_000),
  actionItems: z.array(z.object({
    description: z.string().trim().min(1).max(2_000),
    assigneeName: z.string().trim().max(200).nullable(),
    assigneeEmail: z.email().max(320).nullable(),
    dueOn: z.iso.date().nullable(),
    completed: z.boolean(),
    evidenceTimestamp: z.string().trim().max(32).nullable(),
  }).strict()).max(250),
  decisions: z.array(z.string().trim().min(1).max(2_000)).max(250),
  transcriptIncluded: z.literal(false),
}).strict();
export type OutboundWebhookPayload = z.infer<typeof outboundWebhookPayloadSchema>;

export interface OutboundWebhookEvent {
  type: typeof OUTBOUND_WEBHOOK_EVENT_TYPE;
  version: typeof OUTBOUND_WEBHOOK_EVENT_VERSION;
  id: string;
  proposalId: string;
  meetingId: string;
  approvedAt: string;
  data: OutboundWebhookPayload;
}

/**
 * Builds the event and its exact wire body. The body carries no send time, so
 * it is byte-identical on every retry and replay; freshness lives in the
 * signed timestamp header instead.
 */
export function buildOutboundWebhookEvent(proposal: RoutingProposal): { event: OutboundWebhookEvent; body: string } {
  if (proposal.target !== "webhook" || proposal.operation !== "deliver_approved_meeting") throw new OutboundWebhookBlockedError("Unsupported webhook proposal");
  // Fires only on approved proposals. The store moves an approved (or
  // previously failed, blocked or unknown, all post-approval) proposal to
  // `delivering` before calling the adapter; anything else never leaves.
  if (!proposal.reviewedAt || !["approved", "delivering"].includes(proposal.status)) {
    throw new OutboundWebhookBlockedError(`Only approved proposals are delivered to the webhook (status: ${proposal.status})`);
  }
  const parsed = outboundWebhookPayloadSchema.safeParse(proposal.payload);
  if (!parsed.success) {
    const fields = [...new Set(parsed.error.issues.flatMap((issue) => {
      const prefix = issue.path.join(".");
      if (issue.code === "unrecognized_keys") return issue.keys.map((key) => (prefix ? `${prefix}.${key}` : key));
      return [prefix || "(root)"];
    }))].slice(0, 10).join(", ");
    throw new OutboundWebhookBlockedError(`Proposal payload does not satisfy the outbound webhook contract (fields: ${fields})`);
  }
  const event: OutboundWebhookEvent = {
    type: OUTBOUND_WEBHOOK_EVENT_TYPE,
    version: OUTBOUND_WEBHOOK_EVENT_VERSION,
    id: proposal.idempotencyKey,
    proposalId: proposal.id,
    meetingId: proposal.meetingId,
    approvedAt: proposal.reviewedAt,
    data: parsed.data,
  };
  return { event, body: JSON.stringify(event) };
}

export function signOutboundWebhook(secret: string, timestamp: number | string, rawBody: string): string {
  return `v1=${createHmac("sha256", secret).update(`${timestamp}.${rawBody}`, "utf8").digest("hex")}`;
}

/**
 * Receiver-side check, exported for custom Node consumers and tests. Accepts
 * the header value with one or more space-separated `v1=` entries, compares in
 * constant time, and rejects timestamps outside the tolerance window.
 */
export function verifyOutboundWebhookSignature(
  secret: string,
  headers: { timestamp: string | undefined; signature: string | undefined },
  rawBody: string,
  now = new Date(),
  toleranceSeconds = DEFAULT_OUTBOUND_WEBHOOK_TOLERANCE_SECONDS,
): boolean {
  if (!secret || !headers.timestamp || !headers.signature) return false;
  if (!/^\d{1,12}$/.test(headers.timestamp)) return false;
  const timestamp = Number(headers.timestamp);
  if (Math.abs(Math.floor(now.getTime() / 1_000) - timestamp) > toleranceSeconds) return false;
  const expected = Buffer.from(signOutboundWebhook(secret, headers.timestamp, rawBody), "utf8");
  return headers.signature.split(" ").some((candidate) => {
    const actual = Buffer.from(candidate.trim(), "utf8");
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  });
}

function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

function retryAfterMs(response: Response): number | null {
  const value = response.headers.get("retry-after");
  if (!value || !/^\d{1,6}$/.test(value.trim())) return null;
  return Number(value.trim()) * 1_000;
}

export interface OutboundWebhookReceipt {
  status: number;
  /** Consumer-supplied `id` or `receiptId` from a JSON response body, if any. */
  receiptId: string | null;
  attempts: number;
}

const receiptBodySchema = z.object({
  id: z.string().trim().min(1).max(500).optional(),
  receiptId: z.string().trim().min(1).max(500).optional(),
}).loose();

async function readReceiptId(response: Response): Promise<string | null> {
  let text: string;
  try {
    text = await response.text();
  } catch {
    return null;
  }
  if (!text || text.length > 64_000) return null;
  try {
    const parsed = receiptBodySchema.safeParse(JSON.parse(text));
    if (!parsed.success) return null;
    return parsed.data.receiptId ?? parsed.data.id ?? null;
  } catch {
    return null;
  }
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Delivers one approved webhook proposal with retry and exponential backoff.
 * Every attempt re-signs the identical body with a fresh timestamp and sends
 * the same id, so a consumer that dedupes on `x-mcr-webhook-id` (or
 * `idempotency-key`) keeps exactly one copy across retries and replays.
 */
export async function deliverOutboundWebhook(
  proposal: RoutingProposal,
  config: OutboundWebhookConfig,
  dependencies: OutboundWebhookDependencies = {},
): Promise<OutboundWebhookReceipt> {
  const { body, event } = buildOutboundWebhookEvent(proposal);
  let url: URL;
  try {
    url = validateOutboundWebhookConfig(config);
  } catch (error) {
    if (error instanceof OutboundWebhookConfigurationError) throw new OutboundWebhookBlockedError(error.message);
    throw error;
  }
  const settings = { ...DEFAULT_OUTBOUND_WEBHOOK_RETRY, ...definedOnly(config) };
  const maxAttempts = Math.max(1, Math.min(10, Math.trunc(settings.maxAttempts)));
  const now = dependencies.now ?? (() => new Date());
  const sleep = dependencies.sleep ?? defaultSleep;
  const random = dependencies.random ?? Math.random;

  let ambiguous = false;
  let lastStatus: number | null = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const timestamp = String(Math.floor(now().getTime() / 1_000));
    let response: Response | null = null;
    try {
      response = await fetch(url, {
        method: "POST",
        // Never follow a redirect: a 3xx is recorded as a final rejection.
        redirect: "manual",
        signal: AbortSignal.timeout(settings.timeoutMs),
        headers: {
          "content-type": "application/json",
          "user-agent": "meeting-context-router/0.1",
          [OUTBOUND_WEBHOOK_HEADERS.id]: event.id,
          [OUTBOUND_WEBHOOK_HEADERS.idempotencyKey]: event.id,
          [OUTBOUND_WEBHOOK_HEADERS.timestamp]: timestamp,
          [OUTBOUND_WEBHOOK_HEADERS.signature]: signOutboundWebhook(config.secret, timestamp, body),
          [OUTBOUND_WEBHOOK_HEADERS.attempt]: String(attempt),
        },
        body,
      });
    } catch {
      ambiguous = true;
    }
    if (response?.ok) {
      return { status: response.status, receiptId: await readReceiptId(response), attempts: attempt };
    }
    if (response) {
      lastStatus = response.status;
      await response.body?.cancel().catch(() => undefined);
      if (!isRetryableStatus(response.status)) throw new OutboundWebhookRejectedError(response.status, attempt);
    }
    if (attempt === maxAttempts) break;
    // Exponential backoff with equal jitter, capped; Retry-After raises it up to the cap.
    const exponential = Math.min(settings.backoffMaxMs, settings.backoffBaseMs * 2 ** (attempt - 1));
    let delay = exponential / 2 + random() * (exponential / 2);
    const hinted = response ? retryAfterMs(response) : null;
    if (hinted !== null) delay = Math.max(delay, Math.min(settings.backoffMaxMs, hinted));
    await sleep(Math.round(delay));
  }
  if (ambiguous) throw new OutboundWebhookAmbiguousError(maxAttempts);
  throw new OutboundWebhookRejectedError(lastStatus ?? 0, maxAttempts);
}
