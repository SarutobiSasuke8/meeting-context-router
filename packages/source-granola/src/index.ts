import { randomUUID } from "node:crypto";
import { canonicalMeetingSchema, sha256, stableJson, type CanonicalMeeting } from "@meeting-context-router/core";
import { z } from "zod";

const noteIdSchema = z.string().regex(/^not_[a-zA-Z0-9]{14}$/);
const personSchema = z.object({
  name: z.string().trim().min(1).max(200),
  email: z.email().max(320),
}).loose();

const transcriptItemSchema = z.object({
  speaker: z.object({
    source: z.string().trim().min(1).max(100),
    attribution: z.string().trim().max(200).nullable().optional(),
    diarization_label: z.string().trim().max(200).nullable().optional(),
  }).loose(),
  text: z.string().trim().min(1).max(20_000),
  start_time: z.iso.datetime().nullable().optional(),
  end_time: z.iso.datetime().nullable().optional(),
}).loose();

export const granolaNoteSchema = z.object({
  id: noteIdSchema,
  title: z.string().trim().max(500).nullable(),
  owner: personSchema,
  created_at: z.iso.datetime(),
  updated_at: z.iso.datetime(),
  web_url: z.url().max(2_000),
  calendar_event: z.object({
    event_title: z.string().trim().max(500).nullable().optional(),
    organiser: z.email().max(320).nullable().optional(),
    scheduled_start_time: z.iso.datetime().nullable().optional(),
    scheduled_end_time: z.iso.datetime().nullable().optional(),
  }).loose().nullable().optional(),
  attendees: z.array(personSchema).max(250).default([]),
  summary_text: z.string().max(50_000).default(""),
  summary_markdown: z.string().max(50_000).nullable().optional(),
  transcript: z.array(transcriptItemSchema).max(20_000).nullable().optional(),
}).loose();

const listNotesSchema = z.object({
  notes: z.array(z.object({ id: noteIdSchema }).loose()).max(30),
  hasMore: z.boolean(),
  cursor: z.string().nullable(),
});

export interface GranolaSyncOptions {
  createdAfter?: string | undefined;
  createdBefore?: string | undefined;
  updatedAfter?: string | undefined;
  maxNotes?: number | undefined;
}

export function normalizeGranolaNote(input: unknown, receivedAt = new Date().toISOString()): CanonicalMeeting {
  const note = granolaNoteSchema.parse(input);
  const transcript = note.transcript ?? [];
  const startedAt = note.calendar_event?.scheduled_start_time ?? transcript[0]?.start_time ?? note.created_at;
  const endedAt = note.calendar_event?.scheduled_end_time ?? transcript.at(-1)?.end_time ?? null;
  const participants = new Map(note.attendees.map((person) => [person.email, person]));
  participants.set(note.owner.email, note.owner);
  return canonicalMeetingSchema.parse({
    id: randomUUID(),
    title: note.title || note.calendar_event?.event_title || "Untitled Granola meeting",
    startedAt,
    endedAt,
    participants: [...participants.values()].map((person) => ({ name: person.name, email: person.email, external: null })),
    summary: note.summary_markdown || note.summary_text,
    actionItems: [],
    decisions: [],
    transcript: transcript.map((segment) => ({
      speaker: segment.speaker.diarization_label || segment.speaker.attribution || segment.speaker.source,
      email: null,
      text: segment.text,
      timestamp: segment.start_time ?? null,
    })),
    provenance: {
      source: "granola",
      transport: "api",
      sourceMeetingId: note.id,
      sourceUrl: note.web_url,
      receivedAt,
      sourceHash: sha256(stableJson(note)),
      signatureVerified: false,
    },
    createdAt: receivedAt,
  });
}

async function granolaGet(url: URL, apiKey: string, fetchImpl: typeof fetch): Promise<unknown> {
  const response = await fetchImpl(url, {
    headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
    redirect: "error",
    signal: AbortSignal.timeout(8_000),
  });
  if (!response.ok) throw new Error(`Granola API request failed with status ${response.status}`);
  return response.json();
}

export async function fetchGranolaNotes(
  apiKey: string,
  options: GranolaSyncOptions = {},
  fetchImpl: typeof fetch = fetch,
): Promise<CanonicalMeeting[]> {
  const maxNotes = Math.min(Math.max(options.maxNotes ?? 25, 1), 100);
  const meetings: CanonicalMeeting[] = [];
  let cursor: string | null = null;
  do {
    const listUrl = new URL("https://public-api.granola.ai/v1/notes");
    listUrl.searchParams.set("page_size", String(Math.min(maxNotes - meetings.length, 30)));
    if (options.createdAfter) listUrl.searchParams.set("created_after", options.createdAfter);
    if (options.createdBefore) listUrl.searchParams.set("created_before", options.createdBefore);
    if (options.updatedAfter) listUrl.searchParams.set("updated_after", options.updatedAfter);
    if (cursor) listUrl.searchParams.set("cursor", cursor);
    const page = listNotesSchema.parse(await granolaGet(listUrl, apiKey, fetchImpl));
    for (const item of page.notes) {
      const noteUrl = new URL(`https://public-api.granola.ai/v1/notes/${encodeURIComponent(item.id)}`);
      noteUrl.searchParams.set("include", "transcript");
      meetings.push(normalizeGranolaNote(await granolaGet(noteUrl, apiKey, fetchImpl)));
      if (meetings.length >= maxNotes) return meetings;
      await new Promise((resolve) => setTimeout(resolve, 210));
    }
    cursor = page.hasMore ? page.cursor : null;
  } while (cursor);
  return meetings;
}
