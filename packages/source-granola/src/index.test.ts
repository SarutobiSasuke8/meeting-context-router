import { describe, expect, it } from "vitest";
import { normalizeGranolaNote } from "./index.js";

describe("Granola adapter", () => {
  it("normalizes a note without inventing action items or decisions", () => {
    const meeting = normalizeGranolaNote({
      id: "not_1d3tmYTlCICgjy",
      title: "Quarterly review",
      owner: { name: "Alex", email: "alex@example.com" },
      created_at: "2026-08-12T09:00:00.000Z",
      updated_at: "2026-08-12T10:00:00.000Z",
      web_url: "https://notes.granola.ai/d/example",
      calendar_event: { scheduled_start_time: "2026-08-12T09:00:00.000Z", scheduled_end_time: "2026-08-12T10:00:00.000Z" },
      attendees: [{ name: "Jane", email: "jane@example.com" }],
      summary_text: "Discussed the quarter.",
      summary_markdown: "## Review\n\nDiscussed the quarter.",
      transcript: [{ speaker: { source: "speaker", attribution: "them" }, text: "Good quarter.", start_time: "2026-08-12T09:01:00.000Z" }],
    });
    expect(meeting.title).toBe("Quarterly review");
    expect(meeting.participants).toHaveLength(2);
    expect(meeting.actionItems).toEqual([]);
    expect(meeting.decisions).toEqual([]);
    expect(meeting.provenance.source).toBe("granola");
  });
});
