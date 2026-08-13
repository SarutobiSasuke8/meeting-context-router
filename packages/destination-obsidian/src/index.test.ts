import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { RoutingProposal } from "@meeting-context-router/core";
import { deliverObsidianProposal, ObsidianDeliveryConflictError, renderObsidianMeeting } from "./index.js";

const proposal: RoutingProposal = {
  id: "1af954b7-3949-4231-a9d4-b4cbf992fdb8",
  meetingId: "90a21496-abf2-43e2-a10f-94267228afd4",
  target: "obsidian",
  operation: "write_meeting_note",
  payload: {
    meetingId: "90a21496-abf2-43e2-a10f-94267228afd4",
    title: "Client <script>alert(1)</script>",
    startedAt: "2026-08-12T09:00:00.000Z",
    endedAt: null,
    source: "manual",
    sourceMeetingId: "meeting-1",
    sourceUrl: null,
    participants: [{ name: "Alex", email: "alex@example.com", external: false }],
    summary: "Discussed <img src=x onerror=alert(1)>",
    actionItems: [],
    decisions: [],
    includeTranscript: false
  },
  evidence: ["manual:meeting-1"], confidence: 0.8, status: "approved",
  idempotencyKey: "a".repeat(64), contentHash: "b".repeat(64), createdAt: "2026-08-12T09:01:00.000Z",
  reviewedAt: "2026-08-12T09:02:00.000Z", deliveredAt: null, lastError: null,
  deliveryAttempt: 0, deliveryActor: null, leaseId: null, leaseExpiresAt: null,
  deliveryStartedAt: null, deliveryFinishedAt: null, destinationRequestId: null, destinationResponseStatus: null,
};

describe("Obsidian destination", () => {
  it("creates a deterministic safe filename and neutralizes raw HTML", () => {
    const rendered = renderObsidianMeeting(proposal);
    expect(rendered.filename).toBe("2026-08-12 - client-script-alert-1-script - 90a21496.md");
    expect(rendered.markdown).not.toContain("<script>");
    expect(rendered.markdown).toContain("&lt;script&gt;");
    expect(rendered.markdown).toContain("mutability: review-first");
    expect(rendered.markdown).toContain(`proposal_id: ${JSON.stringify(proposal.id)}`);
    expect(rendered.markdown).toContain(`content_hash: ${JSON.stringify(proposal.contentHash)}`);
  });

  it("is idempotent: redelivering the exact same proposal reports alreadyExisted without conflict", async () => {
    const root = await mkdtemp(join(tmpdir(), "obsidian-dest-"));
    const first = await deliverObsidianProposal(proposal, root);
    expect(first.alreadyExisted).toBe(false);
    const second = await deliverObsidianProposal(proposal, root);
    expect(second.alreadyExisted).toBe(true);
    expect(second.path).toBe(first.path);
  });

  it("refuses to treat a same-named file from a different proposal as a successful delivery", async () => {
    const root = await mkdtemp(join(tmpdir(), "obsidian-dest-"));
    const { filename } = renderObsidianMeeting(proposal);
    await writeFile(join(root, filename), `---\nproposal_id: "some-other-proposal"\ncontent_hash: "${"c".repeat(64)}"\n---\n\nWrong artifact\n`, "utf8");
    await expect(deliverObsidianProposal(proposal, root)).rejects.toBeInstanceOf(ObsidianDeliveryConflictError);
    expect(await readFile(join(root, filename), "utf8")).toContain("Wrong artifact");
  });
});
