import { describe, expect, it } from "vitest";
import type { CanonicalMeeting } from "./schemas.js";
import { createRoutingProposals } from "./proposals.js";

const meeting: CanonicalMeeting = {
  id: "2a364a63-5314-4b83-a899-65001ca35010",
  title: "Product review",
  startedAt: "2026-08-12T09:00:00.000Z",
  endedAt: "2026-08-12T09:30:00.000Z",
  participants: [{ name: "Alex", email: "alex@example.com", external: false }],
  summary: "Reviewed the launch plan.",
  actionItems: [{ description: "Ship the release", assigneeName: "Alex", assigneeEmail: "alex@example.com", dueOn: null, completed: false, evidenceTimestamp: "00:12:00" }],
  decisions: ["Launch on Friday"],
  transcript: [{ speaker: "Alex", email: "alex@example.com", text: "Ship Friday.", timestamp: "00:12:00" }],
  provenance: { source: "manual", transport: "manual", sourceMeetingId: "meeting-1", sourceUrl: null, receivedAt: "2026-08-12T09:31:00.000Z", sourceHash: "a".repeat(64), signatureVerified: false },
  createdAt: "2026-08-12T09:31:00.000Z",
};

describe("createRoutingProposals", () => {
  it("creates separate proposal-first destination payloads", () => {
    const proposals = createRoutingProposals(meeting, "2026-08-12T09:31:00.000Z");
    expect(proposals.map((proposal) => proposal.target)).toEqual(["crm", "obsidian"]);
    expect(proposals.every((proposal) => proposal.status === "pending")).toBe(true);
    expect(proposals[0]?.payload).not.toHaveProperty("transcript");
    expect(proposals[0]?.payload).toHaveProperty("transcriptIncluded", false);
  });

  it("derives stable idempotency keys independently of proposal UUIDs", () => {
    const first = createRoutingProposals(meeting);
    const second = createRoutingProposals(meeting);
    expect(first.map((proposal) => proposal.idempotencyKey)).toEqual(second.map((proposal) => proposal.idempotencyKey));
  });
});
