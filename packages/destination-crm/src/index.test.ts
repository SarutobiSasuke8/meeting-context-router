import { afterEach, describe, expect, it, vi } from "vitest";
import type { RoutingProposal } from "@meeting-context-router/core";
import {
  CrmConfigurationError,
  CrmDeliveryAmbiguousError,
  CrmDeliveryBlockedError,
  CrmDeliveryRejectedError,
  DEFAULT_CRM_MEETING_ACTIVITY_PATH,
  deliverCrmProposal,
  mapCrmMeetingActivityPayload,
  validateCrmDestination,
} from "./index.js";

// The exact shape core's createRoutingProposals stores for a CRM proposal.
const payload = {
  source: "fireflies",
  sourceMeetingId: "ff-meeting-001",
  title: "Q3 partner sync",
  startedAt: "2026-08-27T09:00:00.000Z",
  endedAt: "2026-08-27T09:45:00.000Z",
  sourceUrl: "https://app.fireflies.ai/view/ff-meeting-001",
  participantEmails: ["contact@example.com"],
  summary: "Reviewed rollout blockers and agreed next steps.",
  actionItems: [{ description: "Send the revised proposal", assigneeName: "Alexei", assigneeEmail: "contact@example.com", dueOn: "2026-09-01", completed: false, evidenceTimestamp: "00:12:31" }],
  decisions: ["Proceed with the pilot in September"],
  transcriptIncluded: false,
};

const proposal = {
  id: "09d31134-e73e-43f8-a55f-67157927ec1b",
  meetingId: "5d98fdcf-e1e3-4894-b594-142b5bd6e49a",
  target: "crm",
  operation: "create_meeting_activity",
  payload,
  evidence: ["fireflies:ff-meeting-001"], confidence: 0.8, status: "approved",
  idempotencyKey: "a".repeat(64), createdAt: "2026-08-12T09:00:00.000Z",
  reviewedAt: "2026-08-12T09:01:00.000Z", deliveredAt: null, lastError: null
} satisfies RoutingProposal;

const base = "https://crm.example";
const token = "crm-token-000000000000000000";
const config = { baseUrl: base, activityPath: DEFAULT_CRM_MEETING_ACTIVITY_PATH, apiToken: token };
const activityId = "a0000000-0000-4000-8000-000000000001";

function crmResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}
const receipt = (replayed: boolean) => ({ data: { id: activityId, sourceMeetingId: payload.sourceMeetingId, matchedPersonIds: ["50000000-0000-4000-8000-000000000002"] }, meta: { replayed } });
const crmError = (code: string, message: string) => ({ error: { code, message, requestId: "req-1" } });

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("CRM destination", () => {
  it("blocks before making a request when the activity route is unavailable", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    await expect(deliverCrmProposal(proposal, { baseUrl: "http://127.0.0.1:4100", activityPath: "", apiToken: "" }))
      .rejects.toEqual(expect.objectContaining<Partial<CrmDeliveryBlockedError>>({ name: "CrmDeliveryBlockedError", message: expect.stringContaining("meeting/activity endpoint") }));
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("blocks before making a request when no token is configured", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    await expect(deliverCrmProposal(proposal, { ...config, apiToken: "" })).rejects.toThrow(/CRM_API_TOKEN/);
    expect(fetchSpy).not.toHaveBeenCalled();
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

  it("posts the approved payload to the Agent CRM meeting activity route and records the receipt", async () => {
    const endpoint = validateCrmDestination(config);
    expect(endpoint.origin).toBe("https://crm.example");
    expect(endpoint.pathname).toBe("/v1/activities/meetings");

    const fetchSpy = vi.fn().mockResolvedValue(crmResponse(201, receipt(false)));
    vi.stubGlobal("fetch", fetchSpy);
    const result = await deliverCrmProposal(proposal, config);
    expect(result).toEqual({ status: 201, receiptId: activityId, replayed: false, matchedPersonCount: 1 });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [calledUrl, init] = fetchSpy.mock.calls[0] as [URL, RequestInit];
    expect(String(calledUrl)).toBe("https://crm.example/v1/activities/meetings");
    expect(init.method).toBe("POST");
    expect(init.redirect).toBe("error");
    const headers = new Headers(init.headers);
    expect(headers.get("authorization")).toBe(`Bearer ${token}`);
    expect(headers.get("idempotency-key")).toBe(proposal.idempotencyKey);
    expect(headers.get("content-type")).toBe("application/json");
    expect(JSON.parse(String(init.body))).toEqual(payload);
  });

  it("reports a replay when the CRM returns the original record for the same idempotency key", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(crmResponse(200, receipt(true))));
    const result = await deliverCrmProposal(proposal, config);
    expect(result).toEqual({ status: 200, receiptId: activityId, replayed: true, matchedPersonCount: 1 });
  });

  it("maps the proposal payload onto the contract and strips nothing silently", () => {
    expect(mapCrmMeetingActivityPayload(proposal)).toEqual(payload);
    expect(() => mapCrmMeetingActivityPayload({ ...proposal, payload: { ...payload, transcript: [{ speaker: "A", text: "secret" }] } }))
      .toThrow(/contract \(fields: transcript\)/);
    expect(() => mapCrmMeetingActivityPayload({ ...proposal, payload: { ...payload, transcriptIncluded: true } }))
      .toThrow(/contract \(fields: transcriptIncluded\)/);
    expect(() => mapCrmMeetingActivityPayload({ ...proposal, target: "obsidian", operation: "write_meeting_note" }))
      .toThrow(/Unsupported CRM proposal/);
  });

  it("blocks a payload that does not satisfy the contract before any request", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    await expect(deliverCrmProposal({ ...proposal, payload: { title: "Example" } }, config))
      .rejects.toEqual(expect.objectContaining({ name: "CrmDeliveryBlockedError", message: expect.stringContaining("meeting activity contract") }));
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it.each([
    [401, "unauthorized", false, /CRM_API_TOKEN/],
    [403, "forbidden", false, /activities:write/],
    [404, "not_found", false, /CRM_MEETING_ACTIVITY_PATH/],
    [409, "idempotency_conflict", false, /different content/],
    [422, "validation_failed", false, /contract/],
    [429, "rate_limited", true, /retry later/],
    [503, "unavailable", true, /retry later/],
  ])("maps HTTP %s (%s) to retryable=%s", async (status, code, retryable, pattern) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(crmResponse(status, crmError(code, "detail from the CRM"))));
    const error = await deliverCrmProposal(proposal, config).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(CrmDeliveryRejectedError);
    const rejected = error as CrmDeliveryRejectedError;
    expect(rejected.status).toBe(status);
    expect(rejected.code).toBe(code);
    expect(rejected.retryable).toBe(retryable);
    expect(rejected.message).toMatch(pattern);
    expect(rejected.message).toContain("detail from the CRM");
    expect(rejected.message).not.toContain(token);
  });

  it("treats an accepted request without a recognisable receipt as ambiguous", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("", { status: 201 })));
    await expect(deliverCrmProposal(proposal, config)).rejects.toBeInstanceOf(CrmDeliveryAmbiguousError);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(crmResponse(201, { data: { id: "not-a-uuid" } })));
    await expect(deliverCrmProposal(proposal, config)).rejects.toBeInstanceOf(CrmDeliveryAmbiguousError);
  });

  it("treats a network failure mid-flight as ambiguous, never as failed", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("fetch failed")));
    await expect(deliverCrmProposal(proposal, config)).rejects.toBeInstanceOf(CrmDeliveryAmbiguousError);
  });

  it("never sends the bearer token when the endpoint is rejected", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    await expect(deliverCrmProposal(proposal, { baseUrl: base, activityPath: "/\\evil.example/steal", apiToken: token }))
      .rejects.toBeInstanceOf(CrmDeliveryBlockedError);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
