import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { canonicalMeetingSchema, sha256, stableJson, type CanonicalMeeting } from "@meeting-context-router/core";
import { z } from "zod";

export const firefliesWebhookEventSchema = z.object({
  event: z.enum(["meeting.transcribed", "meeting.summarized"]),
  timestamp: z.number().int().nonnegative(),
  meeting_id: z.string().trim().min(1).max(500),
  client_reference_id: z.string().trim().max(500).optional(),
}).loose();

const attendeeSchema = z.object({
  displayName: z.string().trim().max(200).nullable().optional(),
  name: z.string().trim().max(200).nullable().optional(),
  email: z.email().max(320).nullable().optional(),
}).loose();

export const firefliesTranscriptSchema = z.object({
  id: z.string().trim().min(1).max(500),
  title: z.string().trim().min(1).max(500),
  dateString: z.iso.datetime(),
  duration: z.number().nonnegative().nullable().optional(),
  transcript_url: z.url().max(2_000).nullable().optional(),
  organizer_email: z.email().max(320).nullable().optional(),
  participants: z.array(z.email().max(320)).max(250).nullable().optional(),
  meeting_attendees: z.array(attendeeSchema).max(250).nullable().optional(),
  sentences: z.array(z.object({
    speaker_name: z.string().trim().min(1).max(200),
    text: z.string().trim().min(1).max(20_000),
    start_time: z.number().nonnegative().nullable().optional(),
  }).loose()).max(20_000).nullable().optional(),
  summary: z.object({
    overview: z.string().max(50_000).nullable().optional(),
    short_summary: z.string().max(50_000).nullable().optional(),
    action_items: z.string().max(50_000).nullable().optional(),
  }).loose().nullable().optional(),
}).loose();

const graphQlResponseSchema = z.object({
  data: z.object({ transcript: firefliesTranscriptSchema.nullable() }).nullable().optional(),
  errors: z.array(z.object({ message: z.string() }).loose()).optional(),
}).loose();

const transcriptQuery = `query MeetingContextRouterTranscript($transcriptId: String!) {
  transcript(id: $transcriptId) {
    id title dateString duration transcript_url organizer_email participants
    meeting_attendees { displayName name email }
    sentences { speaker_name text start_time }
    summary { overview short_summary action_items }
  }
}`;

function timestampFromSeconds(seconds: number | null | undefined): string | null {
  if (seconds === null || seconds === undefined) return null;
  const whole = Math.floor(seconds);
  const hours = Math.floor(whole / 3_600).toString().padStart(2, "0");
  const minutes = Math.floor((whole % 3_600) / 60).toString().padStart(2, "0");
  const remainder = (whole % 60).toString().padStart(2, "0");
  return `${hours}:${minutes}:${remainder}`;
}

function parseActionItems(value: string | null | undefined) {
  if (!value) return [];
  return value.split(/\r?\n/)
    .map((line) => line.replace(/^\s*(?:[-*]|\d+[.)])\s*/, "").trim())
    .filter(Boolean)
    .slice(0, 250)
    .map((description) => ({
      description: description.slice(0, 2_000),
      assigneeName: null,
      assigneeEmail: null,
      dueOn: null,
      completed: false,
      evidenceTimestamp: null,
    }));
}

export function verifyFirefliesWebhook(secret: string, signature: string | undefined, rawBody: string): boolean {
  if (!secret || !signature?.startsWith("sha256=")) return false;
  const expected = `sha256=${createHmac("sha256", secret).update(rawBody, "utf8").digest("hex")}`;
  const candidate = Buffer.from(signature, "utf8");
  const expectedBuffer = Buffer.from(expected, "utf8");
  return candidate.length === expectedBuffer.length && timingSafeEqual(candidate, expectedBuffer);
}

export function isFreshFirefliesEvent(timestamp: number, nowEpochMs = Date.now(), toleranceSeconds = 300): boolean {
  return Number.isSafeInteger(timestamp) && Math.abs(nowEpochMs - timestamp) <= toleranceSeconds * 1_000;
}

export function normalizeFirefliesTranscript(input: unknown, receivedAt = new Date().toISOString()): CanonicalMeeting {
  const transcript = firefliesTranscriptSchema.parse(input);
  const attendeeByEmail = new Map((transcript.meeting_attendees ?? [])
    .filter((person) => person.email)
    .map((person) => [person.email!, person]));
  const emails = new Set([...(transcript.participants ?? []), ...attendeeByEmail.keys()]);
  if (transcript.organizer_email) emails.add(transcript.organizer_email);
  const startedAtMs = Date.parse(transcript.dateString);
  const endedAt = transcript.duration === null || transcript.duration === undefined
    ? null
    : new Date(startedAtMs + transcript.duration * 60_000).toISOString();
  return canonicalMeetingSchema.parse({
    id: randomUUID(),
    title: transcript.title,
    startedAt: transcript.dateString,
    endedAt,
    participants: [...emails].map((email) => {
      const attendee = attendeeByEmail.get(email);
      return { name: attendee?.displayName || attendee?.name || email, email, external: null };
    }),
    summary: transcript.summary?.overview || transcript.summary?.short_summary || "",
    actionItems: parseActionItems(transcript.summary?.action_items),
    decisions: [],
    transcript: (transcript.sentences ?? []).map((sentence) => ({
      speaker: sentence.speaker_name,
      email: null,
      text: sentence.text,
      timestamp: timestampFromSeconds(sentence.start_time),
    })),
    provenance: {
      source: "fireflies",
      transport: "webhook",
      sourceMeetingId: transcript.id,
      sourceUrl: transcript.transcript_url ?? null,
      receivedAt,
      sourceHash: sha256(stableJson(transcript)),
      signatureVerified: true,
    },
    createdAt: receivedAt,
  });
}

export async function fetchFirefliesTranscript(
  apiKey: string,
  transcriptId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<CanonicalMeeting> {
  const response = await fetchImpl("https://api.fireflies.ai/graphql", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ query: transcriptQuery, variables: { transcriptId } }),
    redirect: "error",
    signal: AbortSignal.timeout(7_000),
  });
  if (!response.ok) throw new Error(`Fireflies API request failed with status ${response.status}`);
  const payload = graphQlResponseSchema.parse(await response.json());
  if (payload.errors?.length || !payload.data?.transcript) throw new Error("Fireflies transcript was unavailable");
  return normalizeFirefliesTranscript(payload.data.transcript);
}
