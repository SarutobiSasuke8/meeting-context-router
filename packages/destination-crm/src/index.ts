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

function configuredEndpoint(config: CrmDestinationConfig): URL {
  if (!config.activityPath) throw new CrmDeliveryBlockedError("CRM_MEETING_ACTIVITY_PATH is not configured; the current CRM has no meeting/activity endpoint yet");
  if (!config.activityPath.startsWith("/") || config.activityPath.startsWith("//")) throw new CrmDeliveryBlockedError("CRM_MEETING_ACTIVITY_PATH must be one absolute application path");
  const base = new URL(config.baseUrl);
  if (!new Set(["http:", "https:"]).has(base.protocol)) throw new CrmDeliveryBlockedError("CRM_BASE_URL must use http or https");
  const loopback = new Set(["127.0.0.1", "localhost", "::1"]).has(base.hostname);
  if (base.protocol !== "https:" && !loopback) throw new CrmDeliveryBlockedError("Non-loopback CRM_BASE_URL must use https");
  return new URL(config.activityPath, base);
}

export async function deliverCrmProposal(proposal: RoutingProposal, config: CrmDestinationConfig): Promise<{ status: number }> {
  if (proposal.target !== "crm" || proposal.operation !== "create_meeting_activity") throw new CrmDeliveryBlockedError("Unsupported CRM proposal");
  const endpoint = configuredEndpoint(config);
  if (!config.apiToken) throw new CrmDeliveryBlockedError("CRM_API_TOKEN is not configured");
  const response = await fetch(endpoint, {
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
  if (!response.ok) throw new Error(`CRM delivery returned HTTP ${response.status}`);
  return { status: response.status };
}
