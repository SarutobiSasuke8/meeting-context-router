import type { RoutingProposal } from "@meeting-context-router/core";

export interface CrmDestinationConfig {
  baseUrl: string;
  activityPath: string;
  apiToken: string;
  timeoutMs?: number;
}

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
 * Validates the configured CRM base and activity path once and returns the
 * resolved endpoint. The contract: the base is an HTTP(S) origin with no
 * embedded credentials and no meaningful path; the activity path is one
 * absolute application path (single leading slash, no scheme, no authority,
 * no backslashes, no query/fragment, no credentials). After resolution the
 * endpoint origin must equal the base origin, so a malformed or hostile
 * route value can never redirect the bearer token to another host.
 */
export function validateCrmDestination(config: CrmDestinationConfig): URL {
  if (!config.activityPath) throw new CrmConfigurationError("CRM_MEETING_ACTIVITY_PATH is not configured; the current CRM has no meeting/activity endpoint yet");
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

export async function deliverCrmProposal(proposal: RoutingProposal, config: CrmDestinationConfig): Promise<{ status: number; receiptId: string | null }> {
  if (proposal.target !== "crm" || proposal.operation !== "create_meeting_activity") throw new CrmDeliveryBlockedError("Unsupported CRM proposal");
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
      body: JSON.stringify(proposal.payload),
    });
  } catch {
    throw new CrmDeliveryAmbiguousError("CRM delivery timed out or failed mid-flight; the destination may have processed the request");
  }
  if (!response.ok) throw new Error(`CRM delivery returned HTTP ${response.status}`);
  let receiptId: string | null = null;
  try {
    const body = (await response.json()) as Record<string, unknown>;
    const candidate = body.id ?? (body.data as Record<string, unknown> | undefined)?.id;
    if (typeof candidate === "string" && candidate.length <= 500) receiptId = candidate;
  } catch {
    // The destination returned no JSON receipt; the idempotency key remains the reconciliation handle.
  }
  return { status: response.status, receiptId };
}
