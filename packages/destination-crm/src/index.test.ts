import { describe, expect, it, vi } from "vitest";
import type { RoutingProposal } from "@meeting-context-router/core";
import { CrmDeliveryAmbiguousError, CrmDeliveryBlockedError, deliverCrmProposal } from "./index.js";

const proposal = {
  id: "09d31134-e73e-43f8-a55f-67157927ec1b",
  meetingId: "5d98fdcf-e1e3-4894-b594-142b5bd6e49a",
  target: "crm",
  operation: "create_meeting_activity",
  payload: { title: "Example" },
  evidence: ["manual:test"], confidence: 0.8, status: "approved",
  idempotencyKey: "a".repeat(64), contentHash: "b".repeat(64), createdAt: "2026-08-12T09:00:00.000Z",
  reviewedAt: "2026-08-12T09:01:00.000Z", deliveredAt: null, lastError: null,
  deliveryAttempt: 0, deliveryActor: null, leaseId: null, leaseExpiresAt: null,
  deliveryStartedAt: null, deliveryFinishedAt: null, destinationRequestId: null, destinationResponseStatus: null,
} satisfies RoutingProposal;

describe("CRM destination", () => {
  it("blocks before making a request when the activity route is unavailable", async () => {
    await expect(deliverCrmProposal(proposal, { baseUrl: "http://127.0.0.1:4100", activityPath: "", apiToken: "" }))
      .rejects.toEqual(expect.objectContaining<Partial<CrmDeliveryBlockedError>>({ name: "CrmDeliveryBlockedError", message: expect.stringContaining("meeting/activity endpoint") }));
  });

  it("raises an ambiguous-outcome error, not a plain failure, when no response is received (e.g. timeout)", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(Object.assign(new Error("The operation was aborted"), { name: "TimeoutError" }));
    try {
      await expect(deliverCrmProposal(proposal, { baseUrl: "https://crm.example.com", activityPath: "/activities", apiToken: "token-1234567890" }))
        .rejects.toBeInstanceOf(CrmDeliveryAmbiguousError);
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("captures a destination request id from a successful response for the delivery record", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ id: "crm-activity-789" }), { status: 201, headers: { "content-type": "application/json" } }),
    );
    try {
      const result = await deliverCrmProposal(proposal, { baseUrl: "https://crm.example.com", activityPath: "/activities", apiToken: "token-1234567890" });
      expect(result).toEqual({ status: 201, requestId: "crm-activity-789" });
    } finally {
      fetchSpy.mockRestore();
    }
  });
});
