import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { normalizeFathomWebhook, verifyFathomWebhook } from "./index.js";

const body = JSON.stringify({
  title: "Quarterly Business Review",
  meeting_title: "QBR 2026",
  recording_id: 123,
  url: "https://fathom.video/example",
  share_url: "https://fathom.video/share/example",
  created_at: "2026-08-12T10:00:00.000Z",
  scheduled_start_time: "2026-08-12T09:00:00.000Z",
  scheduled_end_time: "2026-08-12T10:00:00.000Z",
  recording_start_time: "2026-08-12T09:01:00.000Z",
  recording_end_time: "2026-08-12T09:59:00.000Z",
  calendar_invitees: [{ name: "Jane Doe", email: "jane@example.com", is_external: true }],
  transcript: [{ speaker: { display_name: "Jane Doe", matched_calendar_invitee_email: "jane@example.com" }, text: "We should ship it.", timestamp: "00:01:00" }],
  default_summary: { markdown_formatted: "We agreed to ship." },
  action_items: [{ description: "Ship it", completed: false, recording_timestamp: "00:01:00", assignee: { name: "Jane Doe", email: "jane@example.com" } }],
});

describe("Fathom adapter", () => {
  it("verifies the documented signed-content format", () => {
    const secretBytes = Buffer.from("unit-test-secret");
    const secret = `whsec_${secretBytes.toString("base64")}`;
    const timestamp = 1_723_456_789;
    const id = "msg_test";
    const signature = createHmac("sha256", secretBytes).update(`${id}.${timestamp}.${body}`).digest("base64");
    expect(verifyFathomWebhook(secret, { "webhook-id": id, "webhook-timestamp": String(timestamp), "webhook-signature": `v1,${signature}` }, body, timestamp)).toBe(true);
    expect(verifyFathomWebhook(secret, { "webhook-id": id, "webhook-timestamp": String(timestamp), "webhook-signature": `v1,${signature}` }, `${body} `, timestamp)).toBe(false);
  });

  it("rejects stale signatures", () => {
    const secretBytes = Buffer.from("unit-test-secret");
    const secret = `whsec_${secretBytes.toString("base64")}`;
    const signature = createHmac("sha256", secretBytes).update(`msg.100.${body}`).digest("base64");
    expect(verifyFathomWebhook(secret, { "webhook-id": "msg", "webhook-timestamp": "100", "webhook-signature": `v1,${signature}` }, body, 1_000, 300)).toBe(false);
  });

  it("normalizes source content without inventing decisions", () => {
    const meeting = normalizeFathomWebhook(body, "2026-08-12T10:01:00.000Z");
    expect(meeting.title).toBe("QBR 2026");
    expect(meeting.participants[0]?.email).toBe("jane@example.com");
    expect(meeting.actionItems[0]?.description).toBe("Ship it");
    expect(meeting.decisions).toEqual([]);
    expect(meeting.provenance.signatureVerified).toBe(true);
  });
});
