import { describe, expect, it, vi } from "vitest";
import { loadRouterClientConfig, RouterClient } from "./client.js";

describe("router MCP client", () => {
  it("rejects embedded URL credentials", () => {
    expect(() => loadRouterClientConfig({ ROUTER_BASE_URL: "https://user:pass@example.com" })).toThrow(/without embedded credentials/);
  });

  it("submits only to the fixed proposal-creation route", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ data: { duplicate: false } }), { status: 202, headers: { "Content-Type": "application/json" } }));
    const client = new RouterClient({ baseUrl: new URL("http://127.0.0.1:4300"), apiToken: "a".repeat(24) }, fetchMock);
    await client.createProposals({
      source: "fathom",
      sourceMeetingId: "meeting-1",
      title: "Review",
      startedAt: "2026-08-12T09:00:00.000Z",
      participants: [], summary: "", actionItems: [], decisions: [], transcript: [],
    });
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe("http://127.0.0.1:4300/v1/intake/agent");
    const headers = fetchMock.mock.calls[0]?.[1]?.headers as Headers;
    expect(headers.get("Authorization")).toBe(`Bearer ${"a".repeat(24)}`);
  });
});
