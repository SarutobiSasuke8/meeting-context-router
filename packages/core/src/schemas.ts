import { z } from "zod";

const boundedText = (max: number) => z.string().trim().min(1).max(max);
const optionalUrl = z.url().max(2_000).nullable();

export const sourceKindSchema = z.enum(["manual", "fathom", "fireflies", "granola", "generic"]);
export type SourceKind = z.infer<typeof sourceKindSchema>;
export const transportKindSchema = z.enum(["manual", "webhook", "api", "mcp"]);
export type TransportKind = z.infer<typeof transportKindSchema>;

export const participantSchema = z.object({
  name: boundedText(200),
  email: z.email().max(320).nullable(),
  external: z.boolean().nullable(),
});
export type Participant = z.infer<typeof participantSchema>;

export const transcriptSegmentSchema = z.object({
  speaker: boundedText(200),
  email: z.email().max(320).nullable(),
  text: boundedText(20_000),
  timestamp: z.string().trim().max(32).nullable(),
});
export type TranscriptSegment = z.infer<typeof transcriptSegmentSchema>;

export const actionItemSchema = z.object({
  description: boundedText(2_000),
  assigneeName: z.string().trim().max(200).nullable(),
  assigneeEmail: z.email().max(320).nullable(),
  dueOn: z.iso.date().nullable(),
  completed: z.boolean(),
  evidenceTimestamp: z.string().trim().max(32).nullable(),
});
export type ActionItem = z.infer<typeof actionItemSchema>;

export const provenanceSchema = z.object({
  source: sourceKindSchema,
  transport: transportKindSchema.default("manual"),
  sourceMeetingId: boundedText(500),
  sourceUrl: optionalUrl,
  receivedAt: z.iso.datetime(),
  sourceHash: z.string().regex(/^[a-f0-9]{64}$/),
  signatureVerified: z.boolean(),
});
export type Provenance = z.infer<typeof provenanceSchema>;

export const canonicalMeetingSchema = z.object({
  id: z.uuid(),
  title: boundedText(500),
  startedAt: z.iso.datetime(),
  endedAt: z.iso.datetime().nullable(),
  participants: z.array(participantSchema).max(250),
  summary: z.string().trim().max(50_000),
  actionItems: z.array(actionItemSchema).max(250),
  decisions: z.array(boundedText(2_000)).max(250),
  transcript: z.array(transcriptSegmentSchema).max(20_000),
  provenance: provenanceSchema,
  createdAt: z.iso.datetime(),
});
export type CanonicalMeeting = z.infer<typeof canonicalMeetingSchema>;

export const agentMeetingIntakeSchema = z.object({
  source: z.enum(["fathom", "fireflies", "granola", "generic"]),
  sourceMeetingId: boundedText(500),
  title: boundedText(500),
  startedAt: z.iso.datetime(),
  endedAt: z.iso.datetime().nullable().optional(),
  sourceUrl: optionalUrl.optional(),
  participants: z.array(z.object({
    name: boundedText(200),
    email: z.email().max(320).nullable().optional(),
    external: z.boolean().nullable().optional(),
  })).max(250).default([]),
  summary: z.string().trim().max(50_000).default(""),
  actionItems: z.array(z.object({
    description: boundedText(2_000),
    assigneeName: z.string().trim().max(200).nullable().optional(),
    assigneeEmail: z.email().max(320).nullable().optional(),
    dueOn: z.iso.date().nullable().optional(),
    completed: z.boolean().default(false),
    evidenceTimestamp: z.string().trim().max(32).nullable().optional(),
  })).max(250).default([]),
  decisions: z.array(boundedText(2_000)).max(250).default([]),
  transcript: z.array(z.object({
    speaker: boundedText(200),
    email: z.email().max(320).nullable().optional(),
    text: boundedText(20_000),
    timestamp: z.string().trim().max(32).nullable().optional(),
  })).max(20_000).default([]),
});
export type AgentMeetingIntake = z.infer<typeof agentMeetingIntakeSchema>;

export const proposalTargetSchema = z.enum(["crm", "obsidian"]);
export const proposalStatusSchema = z.enum(["pending", "approved", "delivering", "rejected", "delivered", "blocked", "failed", "unknown"]);
export type ProposalStatus = z.infer<typeof proposalStatusSchema>;

export const routingProposalSchema = z.object({
  id: z.uuid(),
  meetingId: z.uuid(),
  target: proposalTargetSchema,
  operation: z.string().trim().min(1).max(120),
  payload: z.record(z.string(), z.unknown()),
  evidence: z.array(boundedText(1_000)).max(100),
  confidence: z.number().min(0).max(1),
  status: proposalStatusSchema,
  idempotencyKey: z.string().regex(/^[a-f0-9]{64}$/),
  createdAt: z.iso.datetime(),
  reviewedAt: z.iso.datetime().nullable(),
  deliveredAt: z.iso.datetime().nullable(),
  lastError: z.string().max(2_000).nullable(),
});
export type RoutingProposal = z.infer<typeof routingProposalSchema>;

export const deliveryOutcomeSchema = z.enum(["delivered", "blocked", "failed", "unknown"]);
export type DeliveryOutcome = z.infer<typeof deliveryOutcomeSchema>;

/**
 * A durable record of one delivery attempt, persisted before the destination
 * side effect is invoked. `outcome` stays null while the attempt holds the
 * delivery lease; a crash leaves a null-outcome attempt that reconciliation
 * resolves deterministically.
 */
export const deliveryAttemptSchema = z.object({
  id: z.uuid(),
  proposalId: z.uuid(),
  actor: boundedText(120),
  startedAt: z.iso.datetime(),
  leaseExpiresAt: z.iso.datetime(),
  finishedAt: z.iso.datetime().nullable(),
  idempotencyKey: z.string().regex(/^[a-f0-9]{64}$/),
  contentHash: z.string().regex(/^[a-f0-9]{64}$/),
  destinationStatus: z.number().int().nullable(),
  destinationReceiptId: z.string().max(500).nullable(),
  outcome: deliveryOutcomeSchema.nullable(),
  error: z.string().max(2_000).nullable(),
});
export type DeliveryAttempt = z.infer<typeof deliveryAttemptSchema>;

/** Append-only deletion evidence. Identifiers and hashes only, never content. */
export const deletionEvidenceSchema = z.object({
  id: z.uuid(),
  subjectType: z.literal("meeting"),
  subjectId: z.uuid(),
  sourceHash: z.string().regex(/^[a-f0-9]{64}$/),
  proposalIds: z.array(z.uuid()).max(1_000),
  artifactsRemoved: z.array(z.string().max(500)).max(1_000),
  actor: boundedText(120),
  deletedAt: z.iso.datetime(),
});
export type DeletionEvidence = z.infer<typeof deletionEvidenceSchema>;

const routerStateV1Schema = z.object({
  schemaVersion: z.literal(1),
  meetings: z.array(canonicalMeetingSchema),
  proposals: z.array(routingProposalSchema),
});

export const routerStateSchema = z.object({
  schemaVersion: z.literal(2),
  meetings: z.array(canonicalMeetingSchema),
  proposals: z.array(routingProposalSchema),
  deliveryAttempts: z.array(deliveryAttemptSchema),
  deletionLog: z.array(deletionEvidenceSchema),
});
export type RouterState = z.infer<typeof routerStateSchema>;

export const emptyRouterState = (): RouterState => ({ schemaVersion: 2, meetings: [], proposals: [], deliveryAttempts: [], deletionLog: [] });

/** Parses persisted state at any supported schema version and migrates it to the current shape. */
export function migrateRouterState(raw: unknown): RouterState {
  const versioned = z.object({ schemaVersion: z.number() }).loose().parse(raw);
  if (versioned.schemaVersion === 1) {
    const v1 = routerStateV1Schema.parse(raw);
    return { schemaVersion: 2, meetings: v1.meetings, proposals: v1.proposals, deliveryAttempts: [], deletionLog: [] };
  }
  return routerStateSchema.parse(raw);
}
