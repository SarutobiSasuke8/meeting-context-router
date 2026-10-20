import { randomUUID } from "node:crypto";
import { proposalEditableFieldsSchema, proposalEditSchema, proposalEditHistorySchema, type CanonicalMeeting, type ProposalEdit, type RoutingProposal } from "./schemas.js";
import { sha256, stableJson } from "./hash.js";
import { assertRouteSupported } from "./capabilities.js";

/** Only called inside the store's serialised mutation, after status/revision checks. */
export function applyProposalEdit(proposal: RoutingProposal, input: ProposalEdit, actor: string, now = new Date().toISOString()): RoutingProposal {
  const edit = proposalEditSchema.parse(input);
  const before = proposalEditableFieldsSchema.parse({
    title: proposal.payload.title,
    summary: proposal.payload.summary,
    actionItems: proposal.payload.actionItems,
    targetNotes: proposal.targetNotes ?? [],
  });
  const after = proposalEditableFieldsSchema.parse({ ...before, ...edit.changes });
  assertRouteSupported(proposal.payload.source as CanonicalMeeting["provenance"]["source"], proposal.target,
    { ...proposal.payload, title: after.title, summary: after.summary, actionItems: after.actionItems });
  const history = proposalEditHistorySchema.parse({ revision: edit.expectedRevision + 1, editedAt: now, actor, before, after });
  return {
    ...proposal,
    payload: { ...proposal.payload, title: after.title, summary: after.summary, actionItems: after.actionItems },
    targetNotes: after.targetNotes,
    editHistory: [...(proposal.editHistory ?? []), history],
  };
}

function evidenceFor(meeting: CanonicalMeeting): string[] {
  const evidence = [`${meeting.provenance.source}:${meeting.provenance.sourceMeetingId}`];
  if (meeting.provenance.sourceUrl) evidence.push(meeting.provenance.sourceUrl);
  if (meeting.actionItems.length) evidence.push(`${meeting.actionItems.length} source action item(s)`);
  return evidence;
}

export interface RoutingOptions {
  /** Also propose delivery to the administrator-configured outbound webhook. */
  outboundWebhook?: boolean;
}

export function createRoutingProposals(meeting: CanonicalMeeting, now = new Date().toISOString(), options: RoutingOptions = {}): RoutingProposal[] {
  const base = {
    meetingId: meeting.id,
    evidence: evidenceFor(meeting),
    confidence: meeting.provenance.signatureVerified ? 0.95 : 0.8,
    status: "pending" as const,
    createdAt: now,
    reviewedAt: null,
    deliveredAt: null,
    lastError: null,
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

  assertRouteSupported(meeting.provenance.source, "crm", crmPayload);
  assertRouteSupported(meeting.provenance.source, "obsidian", obsidianPayload);

  const proposals: RoutingProposal[] = [
    {
      ...base,
      id: randomUUID(),
      target: "crm",
      operation: "create_meeting_activity",
      payload: crmPayload,
      idempotencyKey: sha256(`crm:create_meeting_activity:${stableJson(crmPayload)}`),
    },
    {
      ...base,
      id: randomUUID(),
      target: "obsidian",
      operation: "write_meeting_note",
      payload: obsidianPayload,
      idempotencyKey: sha256(`obsidian:write_meeting_note:${stableJson(obsidianPayload)}`),
    },
  ];

  if (options.outboundWebhook) {
    // Same reviewed fields as the other routes, no transcript. The consumer
    // URL is administrator configuration and is never part of the payload.
    const webhookPayload = {
      meetingId: meeting.id,
      source: meeting.provenance.source,
      sourceMeetingId: meeting.provenance.sourceMeetingId,
      title: meeting.title,
      startedAt: meeting.startedAt,
      endedAt: meeting.endedAt,
      sourceUrl: meeting.provenance.sourceUrl,
      participants: meeting.participants,
      summary: meeting.summary,
      actionItems: meeting.actionItems,
      decisions: meeting.decisions,
      transcriptIncluded: false,
    };
    assertRouteSupported(meeting.provenance.source, "webhook", webhookPayload);
    proposals.push({
      ...base,
      id: randomUUID(),
      target: "webhook",
      operation: "deliver_approved_meeting",
      payload: webhookPayload,
      idempotencyKey: sha256(`webhook:deliver_approved_meeting:${stableJson(webhookPayload)}`),
    });
  }
  return proposals;
}
