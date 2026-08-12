import { z } from "zod";

const boundedText = (max: number) => z.string().trim().min(1).max(max);
const optionalUrl = z.url().max(2_000).nullable();

export const sourceKindSchema = z.enum(["manual", "fathom", "fireflies", "granola", "generic"]);
export type SourceKind = z.infer<typeof sourceKindSchema>;

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

export const proposalTargetSchema = z.enum(["crm", "obsidian"]);
export const proposalStatusSchema = z.enum(["pending", "approved", "rejected", "delivered", "blocked", "failed"]);
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

export const routerStateSchema = z.object({
  schemaVersion: z.literal(1),
  meetings: z.array(canonicalMeetingSchema),
  proposals: z.array(routingProposalSchema),
});
export type RouterState = z.infer<typeof routerStateSchema>;

export const emptyRouterState = (): RouterState => ({ schemaVersion: 1, meetings: [], proposals: [] });
