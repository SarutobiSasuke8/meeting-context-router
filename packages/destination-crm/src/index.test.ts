import { afterEach, describe, expect, it, vi } from "vitest";
import type { RoutingProposal } from "@meeting-context-router/core";
import { CrmConfigurationError, CrmDeliveryBlockedError, deliverCrmProposal, validateCrmDestination } from "./index.js";

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

const base = "https://crm.example";
const token = "crm-token-000000000000000000";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("CRM destination", () => {
  it("blocks before making a request when the activity route is unavailable", async () => {
    await expect(deliverCrmProposal(proposal, { baseUrl: "http://127.0.0.1:4100", activityPath: "", apiToken: "" }))
      .rejects.toEqual(expect.objectContaining<Partial<CrmDeliveryBlockedError>>({ name: "CrmDeliveryBlockedError", message: expect.stringContaining("meeting/activity endpoint") }));
  });

  it.each([
    ["backslash network-path reference", "/\\evil.example/steal"],
    ["scheme-relative path", "//evil.example/steal"],
    ["embedded backslash", "/v1\\..\\steal"],
    ["absolute URL", "https://evil.example/steal"],
    ["path-relative value", "v1/activities"],
    ["scheme inside path", "/https://evil.example"],
    ["fragment", "/v1/activities#frag"],
    ["query string", "/v1/activities?next=https://evil.example"],
    ["credentials", "/user:pass@evil.example/"],
    ["encoded forward slash", "/v1%2f..%2fsteal"],
    ["encoded backslash", "/%5Cevil.example/steal"],
    ["encoded dot segment", "/v1/%2e%2e/steal"],
    ["plain dot segment", "/v1/../steal"],
  ])("rejects %s without emitting any request", async (_label, activityPath) => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    expect(() => validateCrmDestination({ baseUrl: base, activityPath, apiToken: token })).toThrow(CrmConfigurationError);
    await expect(deliverCrmProposal(proposal, { baseUrl: base, activityPath, apiToken: token }))
      .rejects.toBeInstanceOf(CrmDeliveryBlockedError);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it.each([
    ["hostile base path", "https://crm.example/tenant-a", "/v1/activities"],
    ["base with credentials", "https://user:pass@crm.example", "/v1/activities"],
    ["base with query", "https://crm.example/?x=1", "/v1/activities"],
    ["non-https remote base", "http://crm.example", "/v1/activities"],
  ])("rejects %s at validation time", (_label, baseUrl, activityPath) => {
    expect(() => validateCrmDestination({ baseUrl, activityPath, apiToken: token })).toThrow(CrmConfigurationError);
  });

  it("accepts valid same-origin paths and keeps the request on the configured origin", async () => {
    const endpoint = validateCrmDestination({ baseUrl: base, activityPath: "/v1/meeting-activities", apiToken: token });
    expect(endpoint.origin).toBe("https://crm.example");
    expect(endpoint.pathname).toBe("/v1/meeting-activities");

    const fetchSpy = vi.fn().mockResolvedValue(new Response("{}", { status: 201 }));
    vi.stubGlobal("fetch", fetchSpy);
    const result = await deliverCrmProposal(proposal, { baseUrl: base, activityPath: "/v1/meeting-activities", apiToken: token });
    expect(result.status).toBe(201);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [calledUrl, init] = fetchSpy.mock.calls[0] as [URL, RequestInit];
    expect(String(calledUrl)).toBe("https://crm.example/v1/meeting-activities");
    expect(new Headers(init.headers).get("authorization")).toBe(`Bearer ${token}`);
  });

  it("never sends the bearer token when the endpoint is rejected", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    await expect(deliverCrmProposal(proposal, { baseUrl: base, activityPath: "/\\evil.example/steal", apiToken: token }))
      .rejects.toBeInstanceOf(CrmDeliveryBlockedError);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
