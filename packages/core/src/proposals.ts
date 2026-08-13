import { randomUUID } from "node:crypto";
import type { CanonicalMeeting, RoutingProposal } from "./schemas.js";
import { sha256, stableJson } from "./hash.js";

function evidenceFor(meeting: CanonicalMeeting): string[] {
  const evidence = [`${meeting.provenance.source}:${meeting.provenance.sourceMeetingId}`];
  if (meeting.provenance.sourceUrl) evidence.push(meeting.provenance.sourceUrl);
  if (meeting.actionItems.length) evidence.push(`${meeting.actionItems.length} source action item(s)`);
  return evidence;
}

export function createRoutingProposals(meeting: CanonicalMeeting, now = new Date().toISOString()): RoutingProposal[] {
  const base = {
    meetingId: meeting.id,
    evidence: evidenceFor(meeting),
    confidence: meeting.provenance.signatureVerified ? 0.95 : 0.8,
    status: "pending" as const,
    createdAt: now,
    reviewedAt: null,
    deliveredAt: null,
    lastError: null,
    deliveryAttempt: 0,
    deliveryActor: null,
    leaseId: null,
    leaseExpiresAt: null,
    deliveryStartedAt: null,
    deliveryFinishedAt: null,
    destinationRequestId: null,
    destinationResponseStatus: null,
  };

  const crmPayload = {
    source: meeting.provenance.source,
    sourceMeetingId: meeting.provenance.sourceMeetingId,
    title: meeting.title,
    startedAt: meeting.startedAt,
    endedAt: meeting.endedAt,
    sourceUrl: meeting.provenance.sourceUrl,
    participantEmails: meeting.participants.flatMap((participant) => participant.email ? [participant.email] : []),
    summary: meeting.summary,
    actionItems: meeting.actionItems,
    decisions: meeting.decisions,
    transcriptIncluded: false,
  };

  const obsidianPayload = {
    meetingId: meeting.id,
    title: meeting.title,
    startedAt: meeting.startedAt,
    endedAt: meeting.endedAt,
    source: meeting.provenance.source,
    sourceMeetingId: meeting.provenance.sourceMeetingId,
    sourceUrl: meeting.provenance.sourceUrl,
    participants: meeting.participants,
    summary: meeting.summary,
    actionItems: meeting.actionItems,
    decisions: meeting.decisions,
    includeTranscript: false,
  };

  return [
    {
      ...base,
      id: randomUUID(),
      target: "crm",
      operation: "create_meeting_activity",
      payload: crmPayload,
      idempotencyKey: sha256(`crm:create_meeting_activity:${stableJson(crmPayload)}`),
      contentHash: sha256(stableJson(crmPayload)),
    },
    {
      ...base,
      id: randomUUID(),
      target: "obsidian",
      operation: "write_meeting_note",
      payload: obsidianPayload,
      idempotencyKey: sha256(`obsidian:write_meeting_note:${stableJson(obsidianPayload)}`),
      contentHash: sha256(stableJson(obsidianPayload)),
    },
  ];
}
