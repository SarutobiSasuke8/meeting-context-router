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
import { CrmDeliveryBlockedError, deliverCrmProposal } from "@meeting-context-router/destination-crm";
import { deliverObsidianProposal } from "@meeting-context-router/destination-obsidian";
import { normalizeFathomWebhook, verifyFathomWebhook } from "@meeting-context-router/source-fathom";
import Fastify from "fastify";
import rawBody from "fastify-raw-body";
import { z } from "zod";
import type { RouterConfig } from "./config.js";
import { normalizeManualIntake } from "./manual.js";
import { JsonRouterStore, StoreConflictError, StoreNotFoundError } from "./store.js";

const idSchema = z.uuid();

function tokenMatches(expected: string, authorization: string | undefined): boolean {
  if (!authorization?.startsWith("Bearer ")) return false;
  const actual = authorization.slice("Bearer ".length);
  const expectedHash = createHash("sha256").update(expected).digest();
  const actualHash = createHash("sha256").update(actual).digest();
  return timingSafeEqual(expectedHash, actualHash);
}

export async function buildApp(config: RouterConfig, store = new JsonRouterStore(config.statePath)) {
  await store.init();
  const app = Fastify({
    bodyLimit: 2 * 1024 * 1024,
    logger: {
      level: config.environment === "test" ? "silent" : "info",
      redact: ["req.headers.authorization", "req.headers.webhook-signature", "body", "transcript", "*.transcript"],
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

  app.addHook("onRequest", async (request, reply) => {
    const publicPath = request.url === "/" || request.url.startsWith("/assets/") || request.url === "/app.js" || request.url === "/styles.css" || request.url.startsWith("/health/");
    const signedWebhook = request.method === "POST" && request.url === "/v1/intake/fathom";
    if (publicPath || signedWebhook || !config.apiToken) return;
    if (!tokenMatches(config.apiToken, request.headers.authorization)) {
      return reply.code(401).send({ error: { code: "unauthorized", message: "A valid bearer token is required", requestId: request.id } });
    }
  });

  app.get("/health/live", async () => ({ ok: true, service: "meeting-context-router", version: "0.1.0" }));
  app.get("/health/ready", async () => ({ ok: true, persistence: "atomic-json", crmConfigured: Boolean(config.crm.activityPath && config.crm.apiToken), fathomConfigured: Boolean(config.fathomWebhookSecret) }));

  app.get("/v1/meetings", async () => ({ data: store.listMeetings() }));
  app.get("/v1/proposals", async (request) => {
    const query = z.object({ status: proposalStatusSchema.optional() }).parse(request.query);
    return { data: store.listProposals(query.status as ProposalStatus | undefined) };
  });
  app.get("/v1/proposals/:id", async (request) => {
    const { id } = z.object({ id: idSchema }).parse(request.params);
    return { data: store.getProposal(id) };
  });

  app.post("/v1/intake/manual", { config: { rateLimit: { max: 30, timeWindow: "1 minute" } } }, async (request, reply) => {
    const result = await store.ingest(normalizeManualIntake(request.body));
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
    const result = await store.ingest(normalizeFathomWebhook(raw));
    return reply.code(result.duplicate ? 200 : 202).send({ data: { meetingId: result.meeting.id, proposalIds: result.proposals.map((proposal) => proposal.id), duplicate: result.duplicate } });
  });

  app.post("/v1/proposals/:id/approve", async (request) => {
    const { id } = z.object({ id: idSchema }).parse(request.params);
    return { data: await store.reviewProposal(id, "approved") };
  });
  app.post("/v1/proposals/:id/reject", async (request) => {
    const { id } = z.object({ id: idSchema }).parse(request.params);
    return { data: await store.reviewProposal(id, "rejected") };
  });
  app.post("/v1/proposals/:id/deliver", async (request, reply) => {
    const { id } = z.object({ id: idSchema }).parse(request.params);
    const proposal = store.getProposal(id);
    if (!["approved", "blocked", "failed"].includes(proposal.status)) throw new StoreConflictError(`Proposal cannot be delivered from ${proposal.status}`);
    try {
      if (proposal.target === "obsidian") {
        const result = await deliverObsidianProposal(proposal, config.obsidianOutputRoot);
        const updated = await store.recordDelivery(id, "delivered", null);
        return { data: { proposal: updated, artifact: basename(result.path), alreadyExisted: result.alreadyExisted } };
      }
      const result = await deliverCrmProposal(proposal, config.crm);
      const updated = await store.recordDelivery(id, "delivered", null);
      return { data: { proposal: updated, destinationStatus: result.status } };
    } catch (error) {
      if (error instanceof CrmDeliveryBlockedError) {
        const updated = await store.recordDelivery(id, "blocked", error.message);
        return reply.code(409).send({ data: { proposal: updated }, error: { code: "destination_blocked", message: error.message, requestId: request.id } });
      }
      const message = error instanceof Error ? error.message.slice(0, 2_000) : "Destination delivery failed";
      await store.recordDelivery(id, "failed", message);
      request.log.error({ err: error, proposalId: id, target: proposal.target }, "Destination delivery failed");
      return reply.code(502).send({ error: { code: "delivery_failed", message: "Destination delivery failed", requestId: request.id } });
    }
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
