import { describe, expect, it } from "vitest";
import type { RoutingProposal } from "@meeting-context-router/core";
import { CrmDeliveryBlockedError, deliverCrmProposal } from "./index.js";

const proposal = {
  id: "09d31134-e73e-43f8-a55f-67157927ec1b",
  meetingId: "5d98fdcf-e1e3-4894-b594-142b5bd6e49a",
  target: "crm",
  operation: "create_meeting_activity",
  payload: { title: "Example" },
  evidence: ["manual:test"], confidence: 0.8, status: "approved",
  idempotencyKey: "a".repeat(64), createdAt: "2026-08-12T09:00:00.000Z",
  reviewedAt: "2026-08-12T09:01:00.000Z", deliveredAt: null, lastError: null
} satisfies RoutingProposal;

describe("CRM destination", () => {
  it("blocks before making a request when the activity route is unavailable", async () => {
    await expect(deliverCrmProposal(proposal, { baseUrl: "http://127.0.0.1:4100", activityPath: "", apiToken: "" }))
      .rejects.toEqual(expect.objectContaining<Partial<CrmDeliveryBlockedError>>({ name: "CrmDeliveryBlockedError", message: expect.stringContaining("meeting/activity endpoint") }));
  });
});
