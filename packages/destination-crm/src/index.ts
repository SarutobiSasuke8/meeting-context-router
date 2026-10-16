import type { RoutingProposal } from "@meeting-context-router/core";
import { z } from "zod";

/** Agent CRM route for the meeting activity contract (version 1). */
export const DEFAULT_CRM_MEETING_ACTIVITY_PATH = "/v1/activities/meetings";

export interface CrmDestinationConfig {
  baseUrl: string;
  activityPath: string;
  apiToken: string;
  timeoutMs?: number;
}

/**
 * Request body of Agent CRM `POST /v1/activities/meetings` (meeting activity
 * contract version 1, `logMeetingActivityInputSchema` in agent-crm
 * `packages/contracts`). The router never sends a transcript, so the sender
 * declaration is the literal `false`. The schema is strict: a payload field the
 * CRM does not know would be stripped silently on the far side, so it is
 * rejected here before any request is made.
 */
export const crmMeetingActivityPayloadSchema = z.object({
  source: z.string().trim().min(1).max(80),
  sourceMeetingId: z.string().trim().min(1).max(500),
  title: z.string().trim().min(1).max(500),
  startedAt: z.iso.datetime(),
  endedAt: z.iso.datetime().nullable(),
  sourceUrl: z.url().max(2_000).nullable(),
  participantEmails: z.array(z.email().max(320)).max(250),
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
export type CrmMeetingActivityPayload = z.infer<typeof crmMeetingActivityPayloadSchema>;

/**
 * Success body of the same route: `201 { data, meta: { replayed: false } }` on
 * first write, `200 { data, meta: { replayed: true } }` when the idempotency
 * key was already committed with identical content. `data.id` is the stable
 * receipt; the CRM returns the original record on replay.
 */
export const crmMeetingActivityReceiptSchema = z.object({
  data: z.object({
    id: z.uuid(),
    sourceMeetingId: z.string().min(1).max(500),
    matchedPersonIds: z.array(z.uuid()).max(250).default([]),
  }).loose(),
  meta: z.object({ replayed: z.boolean() }).loose(),
});

const crmErrorBodySchema = z.object({
  error: z.object({ code: z.string().max(80), message: z.string().max(2_000) }).loose(),
}).loose();

export class CrmDeliveryBlockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CrmDeliveryBlockedError";
  }
}

export class CrmConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CrmConfigurationError";
  }
}

/**
 * The CRM answered with a non-success status. `retryable` separates transient
 * destination trouble (rate limit, server error) from answers that will not
 * change on retry (credential, scope, contract, idempotency conflict), which
 * callers record as `blocked` for an operator.
 */
export class CrmDeliveryRejectedError extends Error {
  readonly status: number;
  readonly code: string | null;
  readonly retryable: boolean;

  constructor(status: number, code: string | null, detail: string | null) {
    const hint = CrmDeliveryRejectedError.hintFor(status, code);
    super(`CRM rejected the meeting activity with HTTP ${status}${code ? ` (${code})` : ""}${hint ? `: ${hint}` : ""}${detail ? ` - ${detail}` : ""}`.slice(0, 2_000));
    this.name = "CrmDeliveryRejectedError";
    this.status = status;
    this.code = code;
    this.retryable = status === 408 || status === 429 || status >= 500;
  }

  private static hintFor(status: number, code: string | null): string | null {
    if (status === 401) return "check CRM_API_TOKEN";
    if (status === 403) return "the CRM key needs the activities:write scope";
    if (status === 404 || status === 405) return "check CRM_MEETING_ACTIVITY_PATH";
    if (status === 409 && code === "idempotency_conflict") return "the idempotency key was already committed with different content; an operator must reconcile";
    if (status === 422) return "the payload does not satisfy the CRM meeting activity contract";
    if (status === 429) return "rate limited, retry later";
    if (status >= 500) return "destination error, retry later";
    return null;
  }
}

/**
 * Validates the configured CRM base and activity path once and returns the
 * resolved endpoint. The contract: the base is an HTTP(S) origin with no
 * embedded credentials and no meaningful path; the activity path is one
 * absolute application path (single leading slash, no scheme, no authority,
 * no backslashes, no query/fragment, no credentials). After resolution the
 * endpoint origin must equal the base origin, so a malformed or hostile
 * route value can never redirect the bearer token to another host.
 */
export function validateCrmDestination(config: CrmDestinationConfig): URL {
  if (!config.activityPath) throw new CrmConfigurationError(`CRM_MEETING_ACTIVITY_PATH is empty; the Agent CRM meeting/activity endpoint is ${DEFAULT_CRM_MEETING_ACTIVITY_PATH}`);
  let base: URL;
  try {
    base = new URL(config.baseUrl);
  } catch {
    throw new CrmConfigurationError("CRM_BASE_URL is not a valid URL");
  }
  if (!new Set(["http:", "https:"]).has(base.protocol)) throw new CrmConfigurationError("CRM_BASE_URL must use http or https");
  if (base.username || base.password) throw new CrmConfigurationError("CRM_BASE_URL must not contain embedded credentials");
  if (base.pathname !== "/" && base.pathname !== "") throw new CrmConfigurationError("CRM_BASE_URL must be a bare origin; put the application path in CRM_MEETING_ACTIVITY_PATH");
  if (base.search || base.hash) throw new CrmConfigurationError("CRM_BASE_URL must not contain a query or fragment");
  const loopback = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]).has(base.hostname);
  if (base.protocol !== "https:" && !loopback) throw new CrmConfigurationError("Non-loopback CRM_BASE_URL must use https");

  const path = config.activityPath;
  if (!path.startsWith("/")) throw new CrmConfigurationError("CRM_MEETING_ACTIVITY_PATH must begin with a single forward slash");
  if (path.startsWith("//")) throw new CrmConfigurationError("CRM_MEETING_ACTIVITY_PATH must not be scheme-relative");
  if (path.includes("\\")) throw new CrmConfigurationError("CRM_MEETING_ACTIVITY_PATH must not contain backslashes");
  if (path.includes("#")) throw new CrmConfigurationError("CRM_MEETING_ACTIVITY_PATH must not contain a fragment");
  if (path.includes("?")) throw new CrmConfigurationError("CRM_MEETING_ACTIVITY_PATH must not contain a query string");
  if (path.includes("@")) throw new CrmConfigurationError("CRM_MEETING_ACTIVITY_PATH must not contain credentials or an authority");
  if (/%2f|%5c|%2e/i.test(path)) throw new CrmConfigurationError("CRM_MEETING_ACTIVITY_PATH must not contain encoded path separators or dot segments");
  if (/(^|\/)\.\.?(\/|$)/.test(path)) throw new CrmConfigurationError("CRM_MEETING_ACTIVITY_PATH must not contain dot segments");
  if (/^\/[a-z][a-z0-9+.-]*:/i.test(path)) throw new CrmConfigurationError("CRM_MEETING_ACTIVITY_PATH must not contain a scheme");

  let endpoint: URL;
  try {
    endpoint = new URL(path, base);
  } catch {
    throw new CrmConfigurationError("CRM_MEETING_ACTIVITY_PATH did not resolve to a valid URL");
  }
  if (endpoint.origin !== base.origin) throw new CrmConfigurationError("CRM_MEETING_ACTIVITY_PATH resolved outside the configured CRM origin");
  if (endpoint.username || endpoint.password) throw new CrmConfigurationError("Resolved CRM endpoint must not contain credentials");
  return endpoint;
}

function configuredEndpoint(config: CrmDestinationConfig): URL {
  try {
    return validateCrmDestination(config);
  } catch (error) {
    if (error instanceof CrmConfigurationError) throw new CrmDeliveryBlockedError(error.message);
    throw error;
  }
}

/**
 * Maps an approved CRM proposal onto the Agent CRM request body. The proposal
 * payload is what the reviewer approved, so nothing is recomputed from the
 * meeting here; the mapping is a contract check. A payload that does not fit
 * the contract blocks before any request leaves the router.
 */
export function mapCrmMeetingActivityPayload(proposal: RoutingProposal): CrmMeetingActivityPayload {
  if (proposal.target !== "crm" || proposal.operation !== "create_meeting_activity") throw new CrmDeliveryBlockedError("Unsupported CRM proposal");
  const parsed = crmMeetingActivityPayloadSchema.safeParse(proposal.payload);
  if (!parsed.success) {
    const fields = [...new Set(parsed.error.issues.flatMap((issue) => {
      const prefix = issue.path.join(".");
      if (issue.code === "unrecognized_keys") return issue.keys.map((key) => (prefix ? `${prefix}.${key}` : key));
      return [prefix || "(root)"];
    }))].slice(0, 10).join(", ");
    throw new CrmDeliveryBlockedError(`Proposal payload does not satisfy the CRM meeting activity contract (fields: ${fields})`);
  }
  return parsed.data;
}

/**
 * The request may or may not have reached the destination (timeout or network
 * failure mid-flight). Callers must record the attempt as `unknown` and
 * reconcile with the same idempotency key instead of blindly retrying.
 */
export class CrmDeliveryAmbiguousError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CrmDeliveryAmbiguousError";
  }
}

export interface CrmDeliveryReceipt {
  status: number;
  receiptId: string;
  /** True when the CRM had already committed this idempotency key and returned the original record. */
  replayed: boolean;
  matchedPersonCount: number;
}

export async function deliverCrmProposal(proposal: RoutingProposal, config: CrmDestinationConfig): Promise<CrmDeliveryReceipt> {
  const payload = mapCrmMeetingActivityPayload(proposal);
  const endpoint = configuredEndpoint(config);
  if (!config.apiToken) throw new CrmDeliveryBlockedError("CRM_API_TOKEN is not configured");
  let response: Response;
  try {
    response = await fetch(endpoint, {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(config.timeoutMs ?? 10_000),
      headers: {
        authorization: `Bearer ${config.apiToken}`,
        "content-type": "application/json",
        "idempotency-key": proposal.idempotencyKey,
        "user-agent": "meeting-context-router/0.1",
      },
      body: JSON.stringify(payload),
    });
  } catch {
    throw new CrmDeliveryAmbiguousError("CRM delivery timed out or failed mid-flight; the destination may have processed the request");
  }
  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  if (!response.ok) {
    const parsed = crmErrorBodySchema.safeParse(body);
    const code = parsed.success ? parsed.data.error.code : null;
    const detail = parsed.success ? parsed.data.error.message.slice(0, 500) : null;
    throw new CrmDeliveryRejectedError(response.status, code, detail);
  }
  const receipt = crmMeetingActivityReceiptSchema.safeParse(body);
  if (!receipt.success) {
    // The CRM accepted the request, so the record most likely exists, but
    // without a receipt the outcome cannot be recorded as delivered. A replay
    // with the same idempotency key returns the original record.
    throw new CrmDeliveryAmbiguousError(`CRM accepted the meeting activity (HTTP ${response.status}) but returned no recognisable receipt; replay with the same idempotency key to reconcile`);
  }
  return {
    status: response.status,
    receiptId: receipt.data.data.id,
    replayed: receipt.data.meta.replayed,
    matchedPersonCount: receipt.data.data.matchedPersonIds.length,
  };
}
