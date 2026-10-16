// Offline Agent CRM for the router's end-to-end delivery proof (apps/api/src/crm-e2e.test.ts).
//
// Usage (from the repository root, after `pnpm install` in both repositories):
//   AGENT_CRM_REPO=/path/to/agent-crm node evals/agent-crm-local.mjs            # keep running, print the env to export
//   AGENT_CRM_REPO=/path/to/agent-crm node evals/agent-crm-local.mjs <command>  # run <command> with the env set, then stop
//
// It starts the real Agent CRM API (apps/api/src/app.ts, buildCrmApi) from a local clone of
// SarutobiSasuke8/agent-crm on a random loopback port, with the real routes, authentication,
// scope checks, request parsing (packages/contracts) and agent disclosure projection. Only the
// storage layer is replaced: a small in-memory repository that mirrors PostgresCrmRepository's
// meeting-activity semantics (idempotency key plus request hash, replay of the original record,
// 409 idempotency_conflict on reuse with different content, case-insensitive participant match).
// Every stored record is validated against the contract's meetingActivitySchema, so this cannot
// drift from the CRM's own request and response schemas without failing here.
//
// Nothing leaves 127.0.0.1. The key is synthetic and printed only for this process. Prefer the
// PostgreSQL path (docker compose in the agent-crm README) when Docker is available.
import { spawn } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const repo = resolve(process.env.AGENT_CRM_REPO ?? "");
if (!process.env.AGENT_CRM_REPO || !existsSync(join(repo, "apps", "api", "src", "app.ts"))) {
  console.error("AGENT_CRM_REPO must point at a local clone of SarutobiSasuke8/agent-crm with dependencies installed");
  process.exit(2);
}

const requireFromMcp = createRequire(pathToFileURL(join(repo, "apps", "mcp", "package.json")));
const { register } = await import(pathToFileURL(requireFromMcp.resolve("tsx/esm/api")).href);
register();
process.env.NODE_ENV = "test";

const { buildCrmApi } = await import(pathToFileURL(join(repo, "apps", "api", "src", "app.ts")).href);
const contracts = await import(pathToFileURL(join(repo, "packages", "contracts", "src", "index.ts")).href);
const { RepositoryError } = await import(pathToFileURL(join(repo, "packages", "db", "src", "repository.ts")).href);

// Synthetic, valid only for this process. Not a credential.
const token = `crm_e2e_${randomBytes(24).toString("hex")}`;
const workspaceId = randomUUID();
const identity = { id: randomUUID(), workspaceId, name: "meeting-context-router e2e", actorType: "integration", scopes: ["records:read", "activities:write"] };

const person = (displayName, email, agentAccess) => ({ id: randomUUID(), displayName, email, title: "", location: "", companyIds: [], agentAccess, version: 1, custom: {} });
const snapshot = {
  workspace: { id: workspaceId, name: "Router e2e workspace", slug: "router-e2e" },
  // Same synthetic people as the agent-crm demo seed, so participant matching is exercised.
  people: [
    person("Maya Chen", "maya@northstar.example", "contact"),
    person("Theo Martin", "theo@lattice.example", "index"),
    person("Imani Brooks", "imani@northstar.example", "none"),
  ],
  companies: [], deals: [], stages: [], members: [], teams: [], properties: [], savedViews: [],
};

const activities = [];
const requestHash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

const reads = {
  health: async () => undefined,
  verifyApiKey: async (candidate) => (candidate === token ? identity : null),
  resolveHumanIdentity: async () => null,
  getSnapshot: async () => structuredClone(snapshot),
  listApiKeys: async () => [],
  listAudit: async () => [],
  async logMeetingActivity(input) {
    const hash = requestHash({
      source: input.source, sourceMeetingId: input.sourceMeetingId, title: input.title, startedAt: input.startedAt,
      endedAt: input.endedAt ?? null, sourceUrl: input.sourceUrl ?? null, participantEmails: input.participantEmails,
      summary: input.summary, actionItems: input.actionItems, decisions: input.decisions,
    });
    const existing = activities.find((row) => row.idempotencyKey === input.idempotencyKey);
    if (existing) {
      if (existing.requestHash !== hash) throw new RepositoryError("Idempotency key was already used for a different request", "idempotency_conflict", 409);
      return { activity: structuredClone(existing.activity), replayed: true };
    }
    const emails = new Set(input.participantEmails.map((email) => email.trim().toLowerCase()).filter(Boolean));
    const matchedPersonIds = snapshot.people.filter((row) => row.email && emails.has(row.email.toLowerCase())).map((row) => row.id);
    const activity = contracts.meetingActivitySchema.parse({
      id: randomUUID(),
      source: input.source, sourceMeetingId: input.sourceMeetingId, title: input.title,
      startedAt: new Date(input.startedAt).toISOString(), endedAt: input.endedAt ? new Date(input.endedAt).toISOString() : null,
      sourceUrl: input.sourceUrl ?? null, summary: input.summary, actionItems: input.actionItems, decisions: input.decisions,
      participantEmails: input.participantEmails, matchedPersonIds, createdAt: new Date().toISOString(),
    });
    activities.push({ idempotencyKey: input.idempotencyKey, requestHash: hash, activity });
    return { activity: structuredClone(activity), replayed: false };
  },
  async listMeetingActivities(limit = 100, filter = {}) {
    return activities
      .map((row) => structuredClone(row.activity))
      .filter((activity) => !filter.sourceMeetingId || activity.sourceMeetingId === filter.sourceMeetingId)
      .filter((activity) => !filter.personId || activity.matchedPersonIds.includes(filter.personId))
      .reverse()
      .slice(0, limit);
  },
};
const repository = new Proxy(reads, {
  get(target, property) {
    if (property in target) return target[property];
    if (typeof property === "symbol" || property === "then") return undefined;
    return async () => {
      throw new Error(`Offline Agent CRM: repository method '${String(property)}' is not available here`);
    };
  },
});

const app = await buildCrmApi(repository);
await app.listen({ host: "127.0.0.1", port: Number(process.env.AGENT_CRM_LOCAL_PORT ?? 0) });
const address = app.server.address();
if (!address || typeof address === "string") throw new Error("Agent CRM API did not bind a TCP port");
const baseUrl = `http://127.0.0.1:${address.port}`;
const env = { ...process.env, AGENT_CRM_E2E_BASE_URL: baseUrl, AGENT_CRM_E2E_TOKEN: token };

async function shutdown(code = 0) {
  await app.close().catch(() => undefined);
  process.exit(code);
}
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());

const command = process.argv.slice(2);
if (command.length === 0) {
  console.error(`Offline Agent CRM listening on ${baseUrl} (real API over an in-memory repository). Export for the e2e test:`);
  console.error(`AGENT_CRM_E2E_BASE_URL=${baseUrl}`);
  console.error(`AGENT_CRM_E2E_TOKEN=${token}`);
  console.error("Press Ctrl+C to stop.");
} else {
  console.error(`Offline Agent CRM listening on ${baseUrl}; running: ${command.join(" ")}`);
  const child = spawn(command[0], command.slice(1), { stdio: "inherit", env, shell: process.platform === "win32" });
  child.on("exit", (code) => void shutdown(code ?? 1));
  child.on("error", (error) => {
    console.error(error.message);
    void shutdown(1);
  });
}
