import type { SourceKind } from "./schemas.js";

export type Capability = "transcript" | "summary" | "actionItems" | "participants" |
  "attachments" | "webhooks" | "replaySafeIds";
export type DestinationKind = "crm" | "obsidian" | "webhook";
export type CapabilityManifest = Readonly<{
  id: string;
  direction: "source" | "destination";
  supports: Readonly<Record<Capability, boolean>>;
}>;

export const sourceCapabilities: Readonly<Record<SourceKind | "fixtures", CapabilityManifest>> = {
  fixtures: { id: "fixtures", direction: "source", supports: { transcript: true, summary: true, actionItems: true, participants: true, attachments: false, webhooks: false, replaySafeIds: true } },
  manual: { id: "manual", direction: "source", supports: { transcript: true, summary: true, actionItems: true, participants: true, attachments: false, webhooks: false, replaySafeIds: true } },
  generic: { id: "generic", direction: "source", supports: { transcript: true, summary: true, actionItems: true, participants: true, attachments: false, webhooks: false, replaySafeIds: true } },
  fathom: { id: "fathom", direction: "source", supports: { transcript: true, summary: true, actionItems: true, participants: true, attachments: false, webhooks: true, replaySafeIds: true } },
  fireflies: { id: "fireflies", direction: "source", supports: { transcript: true, summary: true, actionItems: true, participants: true, attachments: false, webhooks: true, replaySafeIds: true } },
  granola: { id: "granola", direction: "source", supports: { transcript: true, summary: true, actionItems: false, participants: true, attachments: false, webhooks: false, replaySafeIds: true } },
};

export const destinationCapabilities: Readonly<Record<DestinationKind, CapabilityManifest>> = {
  crm: { id: "crm", direction: "destination", supports: { transcript: false, summary: true, actionItems: true, participants: true, attachments: false, webhooks: false, replaySafeIds: true } },
  obsidian: { id: "obsidian", direction: "destination", supports: { transcript: false, summary: true, actionItems: true, participants: true, attachments: false, webhooks: false, replaySafeIds: true } },
  // Generic outbound webhook (n8n, Zapier, custom consumers): HMAC-signed POST
  // of the approved proposal, keyed by the proposal idempotency key.
  webhook: { id: "webhook", direction: "destination", supports: { transcript: false, summary: true, actionItems: true, participants: true, attachments: false, webhooks: true, replaySafeIds: true } },
};

export class UnsupportedRouteError extends Error {}

/** Check the fields actually routed, not optional source data intentionally omitted from proposals. */
export function assertRouteSupported(source: SourceKind, destination: DestinationKind, payload: Record<string, unknown>): void {
  if (!Object.hasOwn(sourceCapabilities, source) || !Object.hasOwn(destinationCapabilities, destination)) {
    throw new UnsupportedRouteError("Unknown source or destination capability manifest");
  }
  const required: Capability[] = ["replaySafeIds"];
  if (typeof payload.summary === "string" && payload.summary.length > 0) required.push("summary");
  if (Array.isArray(payload.actionItems) && payload.actionItems.length > 0) required.push("actionItems");
  if ((Array.isArray(payload.participants) && payload.participants.length > 0) ||
      (Array.isArray(payload.participantEmails) && payload.participantEmails.length > 0)) required.push("participants");
  if (Array.isArray(payload.transcript) && payload.transcript.length > 0) required.push("transcript");
  if (Array.isArray(payload.attachments) && payload.attachments.length > 0) required.push("attachments");
  const unsupported = required.filter((capability) =>
    !sourceCapabilities[source].supports[capability] || !destinationCapabilities[destination].supports[capability]);
  if (unsupported.length) {
    throw new UnsupportedRouteError(`Cannot route ${source} to ${destination}: unsupported capabilities: ${unsupported.join(", ")}`);
  }
}
