import { createHash, timingSafeEqual } from "node:crypto";
import { basename, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import fastifyStatic from "@fastify/static";
import {
  proposalStatusSchema,
  type ProposalStatus,
} from "@meeting-context-router/core";
import { CrmConfigurationError, CrmDeliveryAmbiguousError, CrmDeliveryBlockedError, deliverCrmProposal, validateCrmDestination } from "@meeting-context-router/destination-crm";
import { deliverObsidianProposal, ObsidianArtifactConflictError, removeObsidianArtifact, renderObsidianMeeting } from "@meeting-context-router/destination-obsidian";
import { fetchFathomMeetings, normalizeFathomWebhook, verifyFathomWebhook } from "@meeting-context-router/source-fathom";
import { fetchFirefliesTranscript, firefliesWebhookEventSchema, isFreshFirefliesEvent, verifyFirefliesWebhook } from "@meeting-context-router/source-fireflies";
import { fetchGranolaNotes } from "@meeting-context-router/source-granola";
import Fastify from "fastify";
import rawBody from "fastify-raw-body";
import { z } from "zod";
import type { Principal, RouterConfig, Scope } from "./config.js";
import { normalizeAgentIntake, normalizeManualIntake } from "./manual.js";
import { JsonRouterStore, StoreConflictError, StoreNotFoundError } from "./store.js";

const idSchema = z.uuid();

function tokenMatches(expected: string, authorization: string | undefined): boolean {
  if (!authorization?.startsWith("Bearer ")) return false;
  const actual = authorization.slice("Bearer ".length);
  const expectedHash = createHash("sha256").update(expected).digest();
  const actualHash = createHash("sha256").update(actual).digest();
  return timingSafeEqual(expectedHash, actualHash);
}

type RequestPrincipal = Pick<Principal, "id" | "type" | "scopes">;

declare module "fastify" {
  interface FastifyRequest {
    principal: RequestPrincipal | null;
  }
}

function resolvePrincipal(principals: Principal[], authorization: string | undefined): RequestPrincipal | null {
  let matched: RequestPrincipal | null = null;
  // Compare against every principal so timing does not reveal which token prefix matched.
  for (const principal of principals) {
    if (tokenMatches(principal.token, authorization)) {
      matched = { id: principal.id, type: principal.type, scopes: principal.scopes };
    }
  }
  return matched;
}

function principalAllows(principal: RequestPrincipal, scope: Scope): boolean {
  return principal.scopes.includes(scope) || principal.scopes.includes("admin");
}

export async function buildApp(config: RouterConfig, store = new JsonRouterStore(config.statePath, { key: config.stateKey, previousKey: config.statePreviousKey })) {
  // Configuration failures surface at startup, not during a delivery attempt.
  if (config.crm.activityPath) {
    try {
      validateCrmDestination(config.crm);
    } catch (error) {
      if (error instanceof CrmConfigurationError) throw new Error(`CRM destination is misconfigured: ${error.message}`);
      throw error;
    }
  }
  await store.init();
  const app = Fastify({
    bodyLimit: 2 * 1024 * 1024,
    logger: {
      level: config.environment === "test" ? "silent" : "info",
      redact: ["req.headers.authorization", "req.headers.webhook-signature", "req.headers.x-hub-signature", "body", "transcript", "*.transcript"],
    },
    trustProxy: false,
  });

  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'"],
        imgSrc: ["'self'", "data:"],
        connectSrc: ["'self'"],
        frameAncestors: ["'none'"],
      },
    },
  });
  await app.register(rateLimit, { max: 120, timeWindow: "1 minute" });
  await app.register(rawBody, { field: "rawBody", global: false, encoding: false, runFirst: true });
  await app.register(fastifyStatic, {
    root: resolve(fileURLToPath(new URL("../../web", import.meta.url))),
    prefix: "/",
    index: ["index.html"],
    dotfiles: "deny",
  });

  app.decorateRequest("principal", null);
  app.addHook("onRequest", async (request, reply) => {
    const publicPath = request.url === "/" || request.url.startsWith("/assets/") || request.url === "/app.js" || request.url === "/styles.css" || request.url.startsWith("/health/");
    const signedWebhook = request.method === "POST" && ["/v1/intake/fathom", "/v1/intake/fireflies"].includes(request.url);
    if (publicPath || signedWebhook) return;
    if (config.principals.length === 0) {
      // Loopback development mode without configured principals: config.ts
      // refuses to start non-loopback or production deployments this way.
      request.principal = { id: "anonymous-dev", type: "dev", scopes: ["admin"] };
      return;
    }
    const principal = resolvePrincipal(config.principals, request.headers.authorization);
    if (!principal) {
      return reply.code(401).send({ error: { code: "unauthorized", message: "A valid bearer token is required", requestId: request.id } });
    }
    request.principal = principal;
  });

  function requireScope(scope: Scope) {
    return async (request: import("fastify").FastifyRequest, reply: import("fastify").FastifyReply) => {
      const principal = request.principal;
      if (!principal) {
        return reply.code(401).send({ error: { code: "unauthorized", message: "A valid bearer token is required", requestId: request.id } });
      }
      if (!principalAllows(principal, scope)) {
        request.log.warn({ principalId: principal.id, principalType: principal.type, scopes: principal.scopes, requiredScope: scope, requestId: request.id }, "Authorization denied");
        return reply.code(403).send({ error: { code: "forbidden", message: `The ${scope} scope is required`, requestId: request.id } });
      }
    };
  }

  function auditAction(request: import("fastify").FastifyRequest, action: string, details: Record<string, unknown> = {}) {
    const principal = request.principal;
    request.log.info({
      audit: true,
      action,
      principalId: principal?.id ?? "unauthenticated",
      principalType: principal?.type ?? "none",
      scopes: principal?.scopes ?? [],
      requestId: request.id,
      ...details,
    }, `audit:${action}`);
  }

  // Data minimisation: transcripts are opt-in per deployment. When retention
  // is off, transcript segments are dropped at the ingest boundary; the
  // source hash still proves provenance.
  const applyRetention = (meeting: import("@meeting-context-router/core").CanonicalMeeting) =>
    config.retainTranscripts ? meeting : { ...meeting, transcript: [] };

  app.get("/health/live", async () => ({ ok: true, service: "meeting-context-router", version: "0.1.0" }));
  app.get("/health/ready", async () => ({
    ok: true,
    persistence: "atomic-json",
    stateEncrypted: store.encrypted,
    transcriptRetention: config.retainTranscripts,
    meetingTtlDays: config.meetingTtlDays,
    principalsConfigured: config.principals.length,
    crmConfigured: Boolean(config.crm.activityPath && config.crm.apiToken),
    sources: {
      fathom: { webhook: Boolean(config.fathomWebhookSecret), api: Boolean(config.fathomApiKey) },
      fireflies: { webhook: Boolean(config.firefliesWebhookSecret), api: Boolean(config.firefliesApiKey) },
      granola: { api: Boolean(config.granolaApiKey) },
      mcpBridge: true,
    },
  }));

  const meetingsQuerySchema = z.object({
    limit: z.coerce.number().int().min(1).max(100).default(25),
    offset: z.coerce.number().int().min(0).max(100_000).default(0),
  });
  app.get("/v1/meetings", { preHandler: requireScope("meeting:read") }, async (request) => {
    const query = meetingsQuerySchema.parse(request.query);
    const page = store.listMeetingSummaries(query.limit, query.offset);
    return { data: page.meetings, total: page.total, limit: query.limit, offset: query.offset };
  });
  app.get("/v1/proposals", { preHandler: requireScope("proposal:read") }, async (request) => {
    const query = z.object({ status: proposalStatusSchema.optional() }).parse(request.query);
    return { data: store.listProposals(query.status as ProposalStatus | undefined) };
  });
  app.get("/v1/proposals/:id", { preHandler: requireScope("proposal:read") }, async (request) => {
    const { id } = z.object({ id: idSchema }).parse(request.params);
    return { data: store.getProposal(id) };
  });

  app.post("/v1/intake/manual", { preHandler: requireScope("admin"), config: { rateLimit: { max: 30, timeWindow: "1 minute" } } }, async (request, reply) => {
    const result = await store.ingest(applyRetention(normalizeManualIntake(request.body)));
    auditAction(request, "intake.manual", { meetingId: result.meeting.id, duplicate: result.duplicate });
    return reply.code(result.duplicate ? 200 : 202).send({ data: { meetingId: result.meeting.id, proposalIds: result.proposals.map((proposal) => proposal.id), duplicate: result.duplicate } });
  });

  app.post("/v1/intake/agent", { preHandler: requireScope("meeting:ingest"), config: { rateLimit: { max: 30, timeWindow: "1 minute" } } }, async (request, reply) => {
    const result = await store.ingest(applyRetention(normalizeAgentIntake(request.body)));
    auditAction(request, "intake.agent", { meetingId: result.meeting.id, duplicate: result.duplicate });
    return reply.code(result.duplicate ? 200 : 202).send({ data: { meetingId: result.meeting.id, proposalIds: result.proposals.map((proposal) => proposal.id), duplicate: result.duplicate } });
  });

  app.post("/v1/intake/fathom", {
    config: { rawBody: true, rateLimit: { max: 60, timeWindow: "1 minute" } },
  }, async (request, reply) => {
    if (!config.fathomWebhookSecret) return reply.code(503).send({ error: { code: "fathom_not_configured", message: "Fathom webhook intake is not configured", requestId: request.id } });
    const raw = request.rawBody?.toString("utf8");
    if (!raw) return reply.code(400).send({ error: { code: "raw_body_missing", message: "Raw webhook body is required", requestId: request.id } });
    const headers = {
      "webhook-id": Array.isArray(request.headers["webhook-id"]) ? request.headers["webhook-id"][0] : request.headers["webhook-id"],
      "webhook-timestamp": Array.isArray(request.headers["webhook-timestamp"]) ? request.headers["webhook-timestamp"][0] : request.headers["webhook-timestamp"],
      "webhook-signature": Array.isArray(request.headers["webhook-signature"]) ? request.headers["webhook-signature"][0] : request.headers["webhook-signature"],
    };
    if (!verifyFathomWebhook(config.fathomWebhookSecret, headers, raw, undefined, config.fathomToleranceSeconds)) {
      return reply.code(401).send({ error: { code: "invalid_webhook_signature", message: "Webhook signature is invalid or stale", requestId: request.id } });
    }
    const result = await store.ingest(applyRetention(normalizeFathomWebhook(raw)));
    return reply.code(result.duplicate ? 200 : 202).send({ data: { meetingId: result.meeting.id, proposalIds: result.proposals.map((proposal) => proposal.id), duplicate: result.duplicate } });
  });

  app.post("/v1/intake/fireflies", {
    config: { rawBody: true, rateLimit: { max: 60, timeWindow: "1 minute" } },
  }, async (request, reply) => {
    if (!config.firefliesWebhookSecret || !config.firefliesApiKey) return reply.code(503).send({ error: { code: "fireflies_not_configured", message: "Fireflies webhook and API intake is not configured", requestId: request.id } });
    const raw = request.rawBody?.toString("utf8");
    if (!raw) return reply.code(400).send({ error: { code: "raw_body_missing", message: "Raw webhook body is required", requestId: request.id } });
    const signatureValue = request.headers["x-hub-signature"];
    const signature = Array.isArray(signatureValue) ? signatureValue[0] : signatureValue;
    if (!verifyFirefliesWebhook(config.firefliesWebhookSecret, signature, raw)) {
      return reply.code(401).send({ error: { code: "invalid_webhook_signature", message: "Webhook signature is invalid", requestId: request.id } });
    }
    const event = firefliesWebhookEventSchema.parse(JSON.parse(raw));
    if (!isFreshFirefliesEvent(event.timestamp, undefined, config.firefliesToleranceSeconds)) {
      return reply.code(401).send({ error: { code: "stale_webhook", message: "Webhook event is stale", requestId: request.id } });
    }
    if (event.event !== "meeting.summarized") return reply.code(202).send({ data: { accepted: true, ignored: true, reason: "awaiting meeting.summarized" } });
    try {
      const result = await store.ingest(applyRetention(await fetchFirefliesTranscript(config.firefliesApiKey, event.meeting_id)));
      return reply.code(result.duplicate ? 200 : 202).send({ data: { meetingId: result.meeting.id, proposalIds: result.proposals.map((proposal) => proposal.id), duplicate: result.duplicate } });
    } catch (error) {
      request.log.error({ err: error, source: "fireflies", sourceMeetingId: event.meeting_id }, "Meeting source fetch failed");
      return reply.code(502).send({ error: { code: "source_fetch_failed", message: "Fireflies meeting data could not be fetched", requestId: request.id } });
    }
  });

  const fathomSyncSchema = z.object({
    createdAfter: z.iso.datetime().optional(),
    createdBefore: z.iso.datetime().optional(),
    maxMeetings: z.number().int().min(1).max(100).default(25),
  }).default({ maxMeetings: 25 });
  app.post("/v1/sources/fathom/sync", { preHandler: requireScope("source:sync") }, async (request, reply) => {
    if (!config.fathomApiKey) return reply.code(503).send({ error: { code: "fathom_api_not_configured", message: "Fathom API sync is not configured", requestId: request.id } });
    try {
      const meetings = await fetchFathomMeetings(config.fathomApiKey, fathomSyncSchema.parse(request.body));
      const results = await Promise.all(meetings.map((meeting) => store.ingest(applyRetention(meeting))));
      return reply.code(202).send({ data: { fetched: meetings.length, created: results.filter((result) => !result.duplicate).length, duplicates: results.filter((result) => result.duplicate).length } });
    } catch (error) {
      request.log.error({ err: error, source: "fathom" }, "Meeting source sync failed");
      return reply.code(502).send({ error: { code: "source_sync_failed", message: "Fathom meetings could not be synchronized", requestId: request.id } });
    }
  });

  const granolaSyncSchema = z.object({
    createdAfter: z.iso.date().optional(),
    createdBefore: z.iso.date().optional(),
    updatedAfter: z.iso.date().optional(),
    maxNotes: z.number().int().min(1).max(100).default(25),
  }).default({ maxNotes: 25 });
  app.post("/v1/sources/granola/sync", { preHandler: requireScope("source:sync") }, async (request, reply) => {
    if (!config.granolaApiKey) return reply.code(503).send({ error: { code: "granola_api_not_configured", message: "Granola API sync is not configured", requestId: request.id } });
    try {
      const meetings = await fetchGranolaNotes(config.granolaApiKey, granolaSyncSchema.parse(request.body));
      const results = await Promise.all(meetings.map((meeting) => store.ingest(applyRetention(meeting))));
      return reply.code(202).send({ data: { fetched: meetings.length, created: results.filter((result) => !result.duplicate).length, duplicates: results.filter((result) => result.duplicate).length } });
    } catch (error) {
      request.log.error({ err: error, source: "granola" }, "Meeting source sync failed");
      return reply.code(502).send({ error: { code: "source_sync_failed", message: "Granola notes could not be synchronized", requestId: request.id } });
    }
  });

  app.post("/v1/proposals/:id/approve", { preHandler: requireScope("proposal:review") }, async (request) => {
    const { id } = z.object({ id: idSchema }).parse(request.params);
    const data = await store.reviewProposal(id, "approved");
    auditAction(request, "proposal.approve", { proposalId: id });
    return { data };
  });
  app.post("/v1/proposals/:id/reject", { preHandler: requireScope("proposal:review") }, async (request) => {
    const { id } = z.object({ id: idSchema }).parse(request.params);
    const data = await store.reviewProposal(id, "rejected");
    auditAction(request, "proposal.reject", { proposalId: id });
    return { data };
  });
  app.post("/v1/proposals/:id/deliver", { preHandler: requireScope("proposal:deliver") }, async (request, reply) => {
    const { id } = z.object({ id: idSchema }).parse(request.params);
    // Acquire the durable delivery lease BEFORE any destination side effect:
    // the attempt record and `delivering` status are persisted first, so a
    // crash can never leave a completed side effect looking retryable.
    const attempt = await store.beginDelivery(id, request.principal?.id ?? "unauthenticated", config.deliveryLeaseSeconds);
    const proposal = store.getProposal(id);
    auditAction(request, "proposal.deliver", { proposalId: id, attemptId: attempt.id, target: proposal.target });
    try {
      if (proposal.target === "obsidian") {
        const result = await deliverObsidianProposal(proposal, config.obsidianOutputRoot);
        const updated = await store.finishDelivery(id, attempt.id, "delivered", { destinationReceiptId: result.filename });
        return { data: { proposal: updated, artifact: basename(result.path), alreadyExisted: result.alreadyExisted } };
      }
      const result = await deliverCrmProposal(proposal, config.crm);
      const updated = await store.finishDelivery(id, attempt.id, "delivered", { destinationStatus: result.status, destinationReceiptId: result.receiptId });
      return { data: { proposal: updated, destinationStatus: result.status, destinationReceiptId: result.receiptId } };
    } catch (error) {
      if (error instanceof CrmDeliveryBlockedError || error instanceof ObsidianArtifactConflictError) {
        const updated = await store.finishDelivery(id, attempt.id, "blocked", { error: error.message });
        return reply.code(409).send({ data: { proposal: updated }, error: { code: "destination_blocked", message: error.message, requestId: request.id } });
      }
      if (error instanceof CrmDeliveryAmbiguousError) {
        const updated = await store.finishDelivery(id, attempt.id, "unknown", { error: error.message });
        return reply.code(502).send({ data: { proposal: updated }, error: { code: "delivery_unknown", message: "Delivery result is unknown; reconcile before retrying", requestId: request.id } });
      }
      const message = error instanceof Error ? error.message.slice(0, 2_000) : "Destination delivery failed";
      await store.finishDelivery(id, attempt.id, "failed", { error: message });
      request.log.error({ err: error, proposalId: id, target: proposal.target }, "Destination delivery failed");
      return reply.code(502).send({ error: { code: "delivery_failed", message: "Destination delivery failed", requestId: request.id } });
    }
  });

  app.get("/v1/deliveries/dead-letter", { preHandler: requireScope("proposal:deliver") }, async () => ({
    data: store.listDeadLetter(),
  }));
  app.get("/v1/proposals/:id/attempts", { preHandler: requireScope("proposal:read") }, async (request) => {
    const { id } = z.object({ id: idSchema }).parse(request.params);
    store.getProposal(id);
    return { data: store.listDeliveryAttempts(id) };
  });

  app.get("/v1/meetings/:id", { preHandler: requireScope("meeting:read") }, async (request) => {
    const { id } = z.object({ id: idSchema }).parse(request.params);
    const query = z.object({ includeTranscript: z.enum(["true", "false"]).default("false") }).parse(request.query);
    const meeting = store.getMeeting(id);
    if (query.includeTranscript !== "true") return { data: { ...meeting, transcript: [] } };
    return { data: meeting };
  });

  app.get("/v1/meetings/:id/export", { preHandler: requireScope("admin") }, async (request) => {
    const { id } = z.object({ id: idSchema }).parse(request.params);
    auditAction(request, "meeting.export", { meetingId: id });
    return { data: store.exportMeeting(id) };
  });

  async function cascadeDelete(request: import("fastify").FastifyRequest, meetingId: string) {
    const preview = store.previewMeetingDeletion(meetingId);
    const artifactsRemoved: string[] = [];
    for (const proposalId of preview.deliveredArtifacts) {
      const proposal = store.getProposal(proposalId);
      const rendered = renderObsidianMeeting(proposal);
      if (await removeObsidianArtifact(config.obsidianOutputRoot, rendered.filename)) artifactsRemoved.push(rendered.filename);
    }
    const cascade = await store.deleteMeeting(meetingId, request.principal?.id ?? "unauthenticated", artifactsRemoved);
    auditAction(request, "meeting.delete", { meetingId, proposalCount: cascade.proposalIds.length, artifactsRemoved: artifactsRemoved.length });
    return cascade;
  }

  app.delete("/v1/meetings/:id", { preHandler: requireScope("admin") }, async (request) => {
    const { id } = z.object({ id: idSchema }).parse(request.params);
    const query = z.object({ dryRun: z.enum(["true", "false"]).default("false") }).parse(request.query);
    if (query.dryRun === "true") return { data: { dryRun: true, cascade: store.previewMeetingDeletion(id) } };
    return { data: { dryRun: false, cascade: await cascadeDelete(request, id) } };
  });

  app.post("/v1/retention/sweep", { preHandler: requireScope("admin") }, async (request, reply) => {
    if (config.meetingTtlDays === null) return reply.code(409).send({ error: { code: "retention_not_configured", message: "MEETING_ROUTER_MEETING_TTL_DAYS is not configured", requestId: request.id } });
    const body = z.object({ dryRun: z.boolean().default(false) }).default({ dryRun: false }).parse(request.body ?? {});
    const expired = store.expiredMeetingIds(config.meetingTtlDays);
    if (body.dryRun) return { data: { dryRun: true, expiredMeetingIds: expired } };
    const cascades = [];
    for (const meetingId of expired) cascades.push(await cascadeDelete(request, meetingId));
    return { data: { dryRun: false, deleted: cascades } };
  });

  app.setNotFoundHandler((request, reply) => reply.code(404).send({ error: { code: "not_found", message: "Route not found", requestId: request.id } }));
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof z.ZodError) return reply.code(422).send({ error: { code: "validation_error", message: "Request validation failed", requestId: request.id, issues: error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message })) } });
    if (error instanceof StoreNotFoundError) return reply.code(404).send({ error: { code: "not_found", message: error.message, requestId: request.id } });
    if (error instanceof StoreConflictError) return reply.code(409).send({ error: { code: "conflict", message: error.message, requestId: request.id } });
    request.log.error({ err: error }, "Meeting Context Router request failed");
    return reply.code(500).send({ error: { code: "internal_error", message: "Unexpected server error", requestId: request.id } });
  });

  return app;
}
