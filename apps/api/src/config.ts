import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));

export const scopeSchema = z.enum([
  "meeting:ingest",
  "meeting:read",
  "proposal:read",
  "proposal:review",
  "proposal:deliver",
  "source:sync",
  "admin",
]);
export type Scope = z.infer<typeof scopeSchema>;

export interface Principal {
  id: string;
  type: "human" | "service" | "legacy" | "dev";
  scopes: Scope[];
  token: string;
}

const principalsSchema = z
  .array(
    z
      .object({
        id: z.string().regex(/^[a-z0-9][a-z0-9-]{1,63}$/),
        type: z.enum(["human", "service"]).default("service"),
        token: z.string().min(24),
        scopes: z.array(scopeSchema).min(1),
      })
      .strict(),
  )
  .max(50);

const environmentSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  API_HOST: z.string().trim().min(1).default("127.0.0.1"),
  API_PORT: z.coerce.number().int().min(1).max(65_535).default(4_300),
  MEETING_ROUTER_API_TOKEN: z.string().min(24).optional(),
  MEETING_ROUTER_MCP_TOKEN: z.string().min(24).optional(),
  MEETING_ROUTER_PRINCIPALS: z.string().trim().min(2).optional(),
  FATHOM_WEBHOOK_SECRET: z.string().startsWith("whsec_").optional(),
  FATHOM_API_KEY: z.string().min(16).optional(),
  FATHOM_WEBHOOK_TOLERANCE_SECONDS: z.coerce.number().int().min(30).max(3_600).default(300),
  FIREFLIES_API_KEY: z.string().min(16).optional(),
  FIREFLIES_WEBHOOK_SECRET: z.string().min(16).max(256).optional(),
  FIREFLIES_WEBHOOK_TOLERANCE_SECONDS: z.coerce.number().int().min(30).max(3_600).default(300),
  GRANOLA_API_KEY: z.string().min(16).optional(),
  MEETING_ROUTER_STATE_PATH: z.string().trim().min(1).default("./data/state.json"),
  MEETING_ROUTER_STATE_KEY: z.string().trim().min(1).optional(),
  MEETING_ROUTER_STATE_KEY_PREVIOUS: z.string().trim().min(1).optional(),
  MEETING_ROUTER_RETAIN_TRANSCRIPTS: z.enum(["true", "false"]).default("false"),
  MEETING_ROUTER_MEETING_TTL_DAYS: z.coerce.number().int().min(1).max(3_650).optional(),
  MEETING_ROUTER_DELIVERY_LEASE_SECONDS: z.coerce.number().int().min(10).max(3_600).default(300),
  OBSIDIAN_OUTPUT_ROOT: z.string().trim().min(1).default("./data/outbox/obsidian"),
  CRM_BASE_URL: z.url().default("http://127.0.0.1:4100"),
  CRM_API_TOKEN: z.string().min(16).optional(),
  CRM_MEETING_ACTIVITY_PATH: z.string().trim().optional(),
});

export type RouterConfig = ReturnType<typeof loadConfig>;

const ALL_SCOPES: Scope[] = ["meeting:ingest", "meeting:read", "proposal:read", "proposal:review", "proposal:deliver", "source:sync", "admin"];
const MCP_SCOPES: Scope[] = ["meeting:ingest", "proposal:read"];

function loadPrincipals(parsed: z.infer<typeof environmentSchema>): Principal[] {
  const principals: Principal[] = [];
  if (parsed.MEETING_ROUTER_PRINCIPALS) {
    let raw: unknown;
    try {
      raw = JSON.parse(parsed.MEETING_ROUTER_PRINCIPALS);
    } catch {
      throw new Error("MEETING_ROUTER_PRINCIPALS must be valid JSON");
    }
    for (const entry of principalsSchema.parse(raw)) {
      principals.push({ id: entry.id, type: entry.type, scopes: entry.scopes, token: entry.token });
    }
  }
  if (parsed.MEETING_ROUTER_MCP_TOKEN) {
    principals.push({ id: "mcp-bridge", type: "service", scopes: [...MCP_SCOPES], token: parsed.MEETING_ROUTER_MCP_TOKEN });
  }
  if (parsed.MEETING_ROUTER_API_TOKEN) {
    // Legacy shared token: full authority, kept for migration. Prefer scoped
    // MEETING_ROUTER_PRINCIPALS entries and retire this variable.
    principals.push({ id: "legacy-shared-token", type: "legacy", scopes: [...ALL_SCOPES], token: parsed.MEETING_ROUTER_API_TOKEN });
  }
  const ids = new Set<string>();
  const tokens = new Set<string>();
  for (const principal of principals) {
    if (ids.has(principal.id)) throw new Error(`Duplicate principal id: ${principal.id}`);
    if (tokens.has(principal.token)) throw new Error("Two principals share the same token");
    ids.add(principal.id);
    tokens.add(principal.token);
  }
  return principals;
}

export function loadConfig(environment: NodeJS.ProcessEnv = process.env) {
  const parsed = environmentSchema.parse(environment);
  const principals = loadPrincipals(parsed);
  if (parsed.NODE_ENV === "production" && principals.length === 0) {
    throw new Error("At least one authenticated principal (MEETING_ROUTER_PRINCIPALS, MEETING_ROUTER_MCP_TOKEN, or MEETING_ROUTER_API_TOKEN) is required in production");
  }
  const loopbackHost = new Set(["127.0.0.1", "localhost", "::1"]).has(parsed.API_HOST);
  if (!loopbackHost && principals.length === 0) {
    throw new Error("Authenticated principals are required when API_HOST is not loopback");
  }
  const decodeKey = (name: string, value: string | undefined): Buffer | null => {
    if (!value) return null;
    const key = Buffer.from(value, "base64");
    if (key.length !== 32) throw new Error(`${name} must be 32 bytes of base64 (use: openssl rand -base64 32)`);
    return key;
  };
  const stateKey = decodeKey("MEETING_ROUTER_STATE_KEY", parsed.MEETING_ROUTER_STATE_KEY);
  const statePreviousKey = decodeKey("MEETING_ROUTER_STATE_KEY_PREVIOUS", parsed.MEETING_ROUTER_STATE_KEY_PREVIOUS);
  if (statePreviousKey && !stateKey) throw new Error("MEETING_ROUTER_STATE_KEY_PREVIOUS requires MEETING_ROUTER_STATE_KEY");

  return {
    environment: parsed.NODE_ENV,
    host: parsed.API_HOST,
    port: parsed.API_PORT,
    principals,
    stateKey,
    statePreviousKey,
    retainTranscripts: parsed.MEETING_ROUTER_RETAIN_TRANSCRIPTS === "true",
    meetingTtlDays: parsed.MEETING_ROUTER_MEETING_TTL_DAYS ?? null,
    deliveryLeaseSeconds: parsed.MEETING_ROUTER_DELIVERY_LEASE_SECONDS,
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
