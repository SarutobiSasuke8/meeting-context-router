import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { canonicalMeetingSchema, sha256, type CanonicalMeeting } from "@meeting-context-router/core";
import { z } from "zod";

const personSchema = z.object({
  name: z.string().trim().min(1).max(200),
  email: z.email().max(320).nullable().optional(),
  is_external: z.boolean().nullable().optional(),
}).loose();

const fathomPayloadSchema = z.object({
  title: z.string().trim().min(1).max(500),
  meeting_title: z.string().trim().max(500).nullable().optional(),
  recording_id: z.union([z.number().int().nonnegative(), z.string().trim().min(1).max(500)]),
  url: z.url().max(2_000).nullable().optional(),
  share_url: z.url().max(2_000).nullable().optional(),
  created_at: z.iso.datetime(),
  scheduled_start_time: z.iso.datetime(),
  scheduled_end_time: z.iso.datetime().nullable().optional(),
  recording_start_time: z.iso.datetime().nullable().optional(),
  recording_end_time: z.iso.datetime().nullable().optional(),
  calendar_invitees: z.array(personSchema.extend({
    matched_speaker_display_name: z.string().max(200).nullable().optional(),
  })).max(250).default([]),
  transcript: z.array(z.object({
    speaker: z.object({
      display_name: z.string().trim().min(1).max(200),
      matched_calendar_invitee_email: z.email().max(320).nullable().optional(),
    }).loose(),
    text: z.string().trim().min(1).max(20_000),
    timestamp: z.string().trim().max(32).nullable().optional(),
  }).loose()).max(20_000).nullable().optional(),
  default_summary: z.object({
    markdown_formatted: z.string().max(50_000),
  }).loose().nullable().optional(),
  action_items: z.array(z.object({
    description: z.string().trim().min(1).max(2_000),
    completed: z.boolean().optional(),
    recording_timestamp: z.string().trim().max(32).nullable().optional(),
    assignee: personSchema.nullable().optional(),
  }).loose()).max(250).nullable().optional(),
}).loose();

export interface FathomWebhookHeaders {
  "webhook-id"?: string | undefined;
  "webhook-timestamp"?: string | undefined;
  "webhook-signature"?: string | undefined;
}

export function verifyFathomWebhook(
  secret: string,
  headers: FathomWebhookHeaders,
  rawBody: string,
  nowEpochSeconds = Math.floor(Date.now() / 1_000),
  toleranceSeconds = 300,
): boolean {
  const id = headers["webhook-id"];
  const timestampHeader = headers["webhook-timestamp"];
  const signatureHeader = headers["webhook-signature"];
  if (!id || !timestampHeader || !signatureHeader || !secret.startsWith("whsec_")) return false;

  const timestamp = Number.parseInt(timestampHeader, 10);
  if (!Number.isSafeInteger(timestamp) || Math.abs(nowEpochSeconds - timestamp) > toleranceSeconds) return false;

  const encodedSecret = secret.slice("whsec_".length);
  let secretBytes: Buffer;
  try {
    secretBytes = Buffer.from(encodedSecret, "base64");
  } catch {
    return false;
  }
  if (!secretBytes.length) return false;

  const expected = createHmac("sha256", secretBytes)
    .update(`${id}.${timestampHeader}.${rawBody}`, "utf8")
    .digest();

  return signatureHeader.split(" ").some((versionedSignature) => {
    const encoded = versionedSignature.includes(",") ? versionedSignature.slice(versionedSignature.indexOf(",") + 1) : versionedSignature;
    let candidate: Buffer;
    try {
      candidate = Buffer.from(encoded, "base64");
    } catch {
      return false;
    }
    return candidate.length === expected.length && timingSafeEqual(candidate, expected);
  });
}

export function normalizeFathomWebhook(rawBody: string, receivedAt = new Date().toISOString()): CanonicalMeeting {
  const payload = fathomPayloadSchema.parse(JSON.parse(rawBody));
  return canonicalMeetingSchema.parse({
    id: randomUUID(),
    title: payload.meeting_title || payload.title,
    startedAt: payload.recording_start_time || payload.scheduled_start_time,
    endedAt: payload.recording_end_time || payload.scheduled_end_time || null,
    participants: payload.calendar_invitees.map((person) => ({
      name: person.name,
      email: person.email ?? null,
      external: person.is_external ?? null,
    })),
    summary: payload.default_summary?.markdown_formatted ?? "",
    actionItems: (payload.action_items ?? []).map((item) => ({
      description: item.description,
      assigneeName: item.assignee?.name ?? null,
      assigneeEmail: item.assignee?.email ?? null,
      dueOn: null,
      completed: item.completed ?? false,
      evidenceTimestamp: item.recording_timestamp ?? null,
    })),
    decisions: [],
    transcript: (payload.transcript ?? []).map((segment) => ({
      speaker: segment.speaker.display_name,
      email: segment.speaker.matched_calendar_invitee_email ?? null,
      text: segment.text,
      timestamp: segment.timestamp ?? null,
    })),
    provenance: {
      source: "fathom",
      sourceMeetingId: String(payload.recording_id),
      sourceUrl: payload.share_url ?? payload.url ?? null,
      receivedAt,
      sourceHash: sha256(rawBody),
      signatureVerified: true,
    },
    createdAt: receivedAt,
  });
}
