import { randomUUID } from "node:crypto";
import { agentMeetingIntakeSchema, canonicalMeetingSchema, sha256, stableJson, type AgentMeetingIntake, type CanonicalMeeting } from "@meeting-context-router/core";
import { z } from "zod";

export const manualIntakeSchema = z.object({
  sourceMeetingId: z.string().trim().min(1).max(500).optional(),
  title: z.string().trim().min(1).max(500),
  startedAt: z.iso.datetime(),
  endedAt: z.iso.datetime().nullable().optional(),
  sourceUrl: z.url().max(2_000).nullable().optional(),
  participants: z.array(z.object({
    name: z.string().trim().min(1).max(200),
    email: z.email().max(320).nullable().optional(),
    external: z.boolean().nullable().optional(),
  })).max(250).default([]),
  summary: z.string().trim().max(50_000).default(""),
  actionItems: z.array(z.object({
    description: z.string().trim().min(1).max(2_000),
    assigneeName: z.string().trim().max(200).nullable().optional(),
    assigneeEmail: z.email().max(320).nullable().optional(),
    dueOn: z.iso.date().nullable().optional(),
    completed: z.boolean().default(false),
    evidenceTimestamp: z.string().trim().max(32).nullable().optional(),
  })).max(250).default([]),
  decisions: z.array(z.string().trim().min(1).max(2_000)).max(250).default([]),
  transcript: z.array(z.object({
    speaker: z.string().trim().min(1).max(200),
    email: z.email().max(320).nullable().optional(),
    text: z.string().trim().min(1).max(20_000),
    timestamp: z.string().trim().max(32).nullable().optional(),
  })).max(20_000).default([]),
});

export function normalizeManualIntake(input: unknown, receivedAt = new Date().toISOString()): CanonicalMeeting {
  const parsed = manualIntakeSchema.parse(input);
  const sourceMeetingId = parsed.sourceMeetingId ?? randomUUID();
  return canonicalMeetingSchema.parse({
    id: randomUUID(),
    title: parsed.title,
    startedAt: parsed.startedAt,
    endedAt: parsed.endedAt ?? null,
    participants: parsed.participants.map((person) => ({ name: person.name, email: person.email ?? null, external: person.external ?? null })),
    summary: parsed.summary,
    actionItems: parsed.actionItems.map((item) => ({
      description: item.description,
      assigneeName: item.assigneeName ?? null,
      assigneeEmail: item.assigneeEmail ?? null,
      dueOn: item.dueOn ?? null,
      completed: item.completed,
      evidenceTimestamp: item.evidenceTimestamp ?? null,
    })),
    decisions: parsed.decisions,
    transcript: parsed.transcript.map((segment) => ({ speaker: segment.speaker, email: segment.email ?? null, text: segment.text, timestamp: segment.timestamp ?? null })),
    provenance: {
      source: "manual",
      transport: "manual",
      sourceMeetingId,
      sourceUrl: parsed.sourceUrl ?? null,
      receivedAt,
      sourceHash: sha256(stableJson({ ...parsed, sourceMeetingId })),
      signatureVerified: false,
    },
    createdAt: receivedAt,
  });
}

export function normalizeAgentIntake(input: unknown, receivedAt = new Date().toISOString()): CanonicalMeeting {
  const parsed: AgentMeetingIntake = agentMeetingIntakeSchema.parse(input);
  return canonicalMeetingSchema.parse({
    id: randomUUID(),
    title: parsed.title,
    startedAt: parsed.startedAt,
    endedAt: parsed.endedAt ?? null,
    participants: parsed.participants.map((person) => ({ name: person.name, email: person.email ?? null, external: person.external ?? null })),
    summary: parsed.summary,
    actionItems: parsed.actionItems.map((item) => ({
      description: item.description,
      assigneeName: item.assigneeName ?? null,
      assigneeEmail: item.assigneeEmail ?? null,
      dueOn: item.dueOn ?? null,
      completed: item.completed,
      evidenceTimestamp: item.evidenceTimestamp ?? null,
    })),
    decisions: parsed.decisions,
    transcript: parsed.transcript.map((segment) => ({ speaker: segment.speaker, email: segment.email ?? null, text: segment.text, timestamp: segment.timestamp ?? null })),
    provenance: {
      source: parsed.source,
      transport: "mcp",
      sourceMeetingId: parsed.sourceMeetingId,
      sourceUrl: parsed.sourceUrl ?? null,
      receivedAt,
      sourceHash: sha256(stableJson(parsed)),
      signatureVerified: false,
    },
    createdAt: receivedAt,
  });
}
