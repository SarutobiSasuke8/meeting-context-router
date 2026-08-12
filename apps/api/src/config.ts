import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));

const environmentSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  API_HOST: z.string().trim().min(1).default("127.0.0.1"),
  API_PORT: z.coerce.number().int().min(1).max(65_535).default(4_300),
  MEETING_ROUTER_API_TOKEN: z.string().min(24).optional(),
  FATHOM_WEBHOOK_SECRET: z.string().startsWith("whsec_").optional(),
  FATHOM_API_KEY: z.string().min(16).optional(),
  FATHOM_WEBHOOK_TOLERANCE_SECONDS: z.coerce.number().int().min(30).max(3_600).default(300),
  FIREFLIES_API_KEY: z.string().min(16).optional(),
  FIREFLIES_WEBHOOK_SECRET: z.string().min(16).max(256).optional(),
  FIREFLIES_WEBHOOK_TOLERANCE_SECONDS: z.coerce.number().int().min(30).max(3_600).default(300),
  GRANOLA_API_KEY: z.string().min(16).optional(),
  MEETING_ROUTER_STATE_PATH: z.string().trim().min(1).default("./data/state.json"),
  OBSIDIAN_OUTPUT_ROOT: z.string().trim().min(1).default("./data/outbox/obsidian"),
  CRM_BASE_URL: z.url().default("http://127.0.0.1:4100"),
  CRM_API_TOKEN: z.string().min(16).optional(),
  CRM_MEETING_ACTIVITY_PATH: z.string().trim().optional(),
});

export type RouterConfig = ReturnType<typeof loadConfig>;

export function loadConfig(environment: NodeJS.ProcessEnv = process.env) {
  const parsed = environmentSchema.parse(environment);
  if (parsed.NODE_ENV === "production" && !parsed.MEETING_ROUTER_API_TOKEN) {
    throw new Error("MEETING_ROUTER_API_TOKEN is required in production");
  }
  const loopbackHost = new Set(["127.0.0.1", "localhost", "::1"]).has(parsed.API_HOST);
  if (!loopbackHost && !parsed.MEETING_ROUTER_API_TOKEN) {
    throw new Error("MEETING_ROUTER_API_TOKEN is required when API_HOST is not loopback");
  }
  return {
    environment: parsed.NODE_ENV,
    host: parsed.API_HOST,
    port: parsed.API_PORT,
    apiToken: parsed.MEETING_ROUTER_API_TOKEN ?? null,
    fathomApiKey: parsed.FATHOM_API_KEY ?? null,
    fathomWebhookSecret: parsed.FATHOM_WEBHOOK_SECRET ?? null,
    fathomToleranceSeconds: parsed.FATHOM_WEBHOOK_TOLERANCE_SECONDS,
    firefliesApiKey: parsed.FIREFLIES_API_KEY ?? null,
    firefliesWebhookSecret: parsed.FIREFLIES_WEBHOOK_SECRET ?? null,
    firefliesToleranceSeconds: parsed.FIREFLIES_WEBHOOK_TOLERANCE_SECONDS,
    granolaApiKey: parsed.GRANOLA_API_KEY ?? null,
    statePath: resolve(repositoryRoot, parsed.MEETING_ROUTER_STATE_PATH),
    obsidianOutputRoot: resolve(repositoryRoot, parsed.OBSIDIAN_OUTPUT_ROOT),
    crm: {
      baseUrl: parsed.CRM_BASE_URL,
      activityPath: parsed.CRM_MEETING_ACTIVITY_PATH ?? "",
      apiToken: parsed.CRM_API_TOKEN ?? "",
    },
  };
}
