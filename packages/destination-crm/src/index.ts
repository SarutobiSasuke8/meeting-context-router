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

/**
 * Thrown when no HTTP response was received at all (timeout, aborted connection, DNS/TCP
 * failure): the request may or may not have reached and been processed by the CRM. Unlike a
 * definite non-2xx response, this must never be treated as a plain retryable failure, since a
 * blind retry could duplicate a side effect the CRM already committed.
 */
export class CrmDeliveryAmbiguousError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "CrmDeliveryAmbiguousError";
  }
}

function configuredEndpoint(config: CrmDestinationConfig): URL {
  if (!config.activityPath) throw new CrmDeliveryBlockedError("CRM_MEETING_ACTIVITY_PATH is not configured; the current CRM has no meeting/activity endpoint yet");
  if (!config.activityPath.startsWith("/") || config.activityPath.startsWith("//")) throw new CrmDeliveryBlockedError("CRM_MEETING_ACTIVITY_PATH must be one absolute application path");
  const base = new URL(config.baseUrl);
  if (!new Set(["http:", "https:"]).has(base.protocol)) throw new CrmDeliveryBlockedError("CRM_BASE_URL must use http or https");
  const loopback = new Set(["127.0.0.1", "localhost", "::1"]).has(base.hostname);
  if (base.protocol !== "https:" && !loopback) throw new CrmDeliveryBlockedError("Non-loopback CRM_BASE_URL must use https");
  return new URL(config.activityPath, base);
}

export async function deliverCrmProposal(proposal: RoutingProposal, config: CrmDestinationConfig): Promise<{ status: number; requestId: string | null }> {
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
  } catch (error) {
    throw new CrmDeliveryAmbiguousError(
      `CRM delivery received no response (idempotency key ${proposal.idempotencyKey}); the destination may have already processed it`,
      { cause: error },
    );
  }
  if (!response.ok) throw new Error(`CRM delivery returned HTTP ${response.status}`);

  let requestId = response.headers.get("x-request-id");
  if (!requestId) {
    const body = (await response.clone().json().catch(() => null)) as { id?: unknown; requestId?: unknown } | null;
    const candidate = body?.id ?? body?.requestId;
    requestId = typeof candidate === "string" ? candidate : null;
  }
  return { status: response.status, requestId };
}
