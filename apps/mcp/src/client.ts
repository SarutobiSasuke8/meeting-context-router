import type { AgentMeetingIntake } from "@meeting-context-router/core";
import { z } from "zod";

const clientConfigSchema = z.object({
  ROUTER_BASE_URL: z.url().default("http://127.0.0.1:4300"),
  MEETING_ROUTER_API_TOKEN: z.string().min(24).optional(),
});

export interface RouterClientConfig {
  baseUrl: URL;
  apiToken: string | null;
}

export function loadRouterClientConfig(environment: NodeJS.ProcessEnv = process.env): RouterClientConfig {
  const parsed = clientConfigSchema.parse(environment);
  const baseUrl = new URL(parsed.ROUTER_BASE_URL);
  if (!["http:", "https:"].includes(baseUrl.protocol) || baseUrl.username || baseUrl.password) {
    throw new Error("ROUTER_BASE_URL must be an HTTP(S) URL without embedded credentials");
  }
  return { baseUrl, apiToken: parsed.MEETING_ROUTER_API_TOKEN ?? null };
}

export class RouterClient {
  constructor(
    private readonly config: RouterClientConfig,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private async request(path: string, init: RequestInit = {}): Promise<Record<string, unknown>> {
    const url = new URL(path, this.config.baseUrl);
    const headers = new Headers(init.headers);
    headers.set("Accept", "application/json");
    if (init.body) headers.set("Content-Type", "application/json");
    if (this.config.apiToken) headers.set("Authorization", `Bearer ${this.config.apiToken}`);
    const response = await this.fetchImpl(url, {
      ...init,
      headers,
      redirect: "error",
      signal: AbortSignal.timeout(8_000),
    });
    if (!response.ok) throw new Error(`Meeting Context Router request failed with status ${response.status}`);
    return z.record(z.string(), z.unknown()).parse(await response.json());
  }

  status() {
    return this.request("/health/ready");
  }

  listProposals(status?: string) {
    const path = status ? `/v1/proposals?status=${encodeURIComponent(status)}` : "/v1/proposals";
    return this.request(path);
  }

  createProposals(meeting: AgentMeetingIntake) {
    return this.request("/v1/intake/agent", { method: "POST", body: JSON.stringify(meeting) });
  }
}
