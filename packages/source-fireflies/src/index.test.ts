import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { isFreshFirefliesEvent, normalizeFirefliesTranscript, verifyFirefliesWebhook } from "./index.js";

describe("Fireflies adapter", () => {
  it("verifies the documented X-Hub-Signature format", () => {
    const body = JSON.stringify({ event: "meeting.summarized", timestamp: 1_000, meeting_id: "abc" });
    const signature = `sha256=${createHmac("sha256", "secret").update(body).digest("hex")}`;
    expect(verifyFirefliesWebhook("secret", signature, body)).toBe(true);
    expect(verifyFirefliesWebhook("secret", signature, `${body} `)).toBe(false);
  });

  it("rejects stale webhook events", () => {
    expect(isFreshFirefliesEvent(1_000, 301_001, 300)).toBe(false);
  });

  it("normalizes GraphQL transcript data with provenance", () => {
    const meeting = normalizeFirefliesTranscript({
      id: "ff-1",
      title: "Weekly sync",
      dateString: "2026-08-12T09:00:00.000Z",
      duration: 30,
      transcript_url: "https://app.fireflies.ai/view/ff-1",
      organizer_email: "alex@example.com",
      participants: ["jane@example.com"],
      meeting_attendees: [{ displayName: "Jane", email: "jane@example.com" }],
      sentences: [{ speaker_name: "Jane", text: "Ship it", start_time: 65 }],
      summary: { overview: "Agreed to ship.", action_items: "- Ship release" },
    });
    expect(meeting.participants.map((person) => person.email)).toContain("jane@example.com");
    expect(meeting.actionItems[0]?.description).toBe("Ship release");
    expect(meeting.transcript[0]?.timestamp).toBe("00:01:05");
    expect(meeting.provenance.transport).toBe("webhook");
  });
});
