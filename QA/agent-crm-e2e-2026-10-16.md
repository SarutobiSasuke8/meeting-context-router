# QA record: Agent CRM end-to-end delivery (2026-10-16)

Roadmap item: "Add the Agent CRM meeting/activity endpoint and complete an end-to-end CRM delivery" (Project Control Plane `md-b47fd3eb25`).

## Scope

- Agent CRM side: SarutobiSasuke8/agent-crm PR #10 added `POST /v1/activities/meetings` (meeting activity contract version 1) with `Idempotency-Key`, replay of the original record, and the `crm_log_meeting_activity` and `crm_list_meeting_activities` MCP tools.
- Router side (this record): `packages/destination-crm` now maps the approved proposal onto that contract, sends the proposal idempotency key, records the CRM receipt, and maps CRM answers into the delivery attempt outcomes (`delivered`, `blocked`, `failed`, `unknown`). `CRM_MEETING_ACTIVITY_PATH` defaults to `/v1/activities/meetings`.

## Environment

- Windows 11, Node 22.22.1, pnpm 11.16.0 (workspace pinned).
- Agent CRM clone at main (`ff22215`), dependencies installed.
- Docker Desktop 4.86.0 is installed but its engine did not start (WSL `docker-desktop` distro stayed `Stopped`; the backend raised an error dialog offering only "Quit" or "Reset to factory defaults"). No reset was attempted. PostgreSQL is not installed natively. The PostgreSQL path was therefore not available on this machine.

## What ran

### Unit tests (synthetic, no network)

`pnpm --filter @meeting-context-router/destination-crm test`: 33 passed. Covers the strict payload contract (unknown fields, `transcriptIncluded: true`, wrong target are rejected before any request), the receipt parse (`201` first write, `200` replay), HTTP status mapping (`401`, `403`, `404`, `409 idempotency_conflict`, `422` not retryable; `429`, `503` retryable), `2xx` without a receipt and network failure as ambiguous, hostile path and base rejection with no request and no bearer header emitted.

`pnpm --filter @meeting-context-router/api exec vitest run src/app.test.ts`: 5 passed. Through the HTTP API with a stubbed `fetch`: blocked while `CRM_API_TOKEN` is unset (no request); approved proposal delivered with the receipt on the attempt record and a second delivery refused; `503` becomes `failed` and the retry delivers with the same idempotency key; `422` becomes `blocked` with the CRM detail in the message and no token leak.

### End-to-end proof (real Agent CRM API, in-memory storage)

Command:

```bash
AGENT_CRM_REPO="C:/Dev/Projects/CRM Build" node evals/agent-crm-local.mjs pnpm --filter @meeting-context-router/api exec vitest run src/crm-e2e.test.ts
```

Result: `Tests 3 passed (3)`, CRM API on `http://127.0.0.1:50301`.

`evals/agent-crm-local.mjs` starts the CRM's real `buildCrmApi` (routes, bearer authentication, scope checks, `logMeetingActivityInputSchema` parsing, agent disclosure projection, error handler) from the local clone through `tsx`, over an in-memory repository that mirrors `PostgresCrmRepository.logMeetingActivity` (request hash over the same fields, replay of the original record for the same key, `409 idempotency_conflict` for the same key with different content, case-insensitive participant match) and validates every stored record with the contract's `meetingActivitySchema`. Only the database layer is replaced.

Assertions that passed:

1. Loopback-only guard on `AGENT_CRM_E2E_BASE_URL`.
2. One synthetic meeting (fresh `router-e2e-<uuid>` source meeting id) through `POST /v1/intake/agent`, approval, `POST /v1/proposals/:id/deliver`: router responds `200`, proposal `delivered`, `destinationStatus 201`, `replayed false`, receipt id is a UUID. `GET /v1/activities/meetings?sourceMeetingId=` on the CRM returns exactly one record whose id equals the receipt and whose source, title, times, summary, decisions, participant emails and action items equal the approved payload; the transcript line is absent; `matchedPersonIds` length equals the delivery response's `matchedPersonCount` (one match, `maya@northstar.example`). The router's attempt record carries `outcome delivered`, `destinationStatus 201`, the receipt id and the proposal idempotency key. Calling the adapter again with the same proposal returns `200`, `replayed true`, the same receipt id, and the CRM still holds one record. A second API delivery of the delivered proposal is refused with `409`.
3. Ambiguous delivery: `fetch` lets the request reach the CRM, then throws. Router responds `502 delivery_unknown`, the proposal is `unknown` and listed in `GET /v1/deliveries/dead-letter`, the CRM holds one record. Delivering again responds `200` with `destinationStatus 200`, `replayed true`, the same receipt id; the CRM still holds exactly one record; attempts read `["unknown", "delivered"]` with one shared idempotency key; the dead-letter view is empty.

### Full check

`pnpm check` (build, typecheck, every workspace test) on the branch: exit 0. core 2, source-fathom 3, source-fireflies 3, source-granola 1, destination-obsidian 7, destination-crm 33, mcp 2, api 24 passed with the 4 e2e cases skipped (no `AGENT_CRM_E2E_*` in that run). Note for this laptop: the first test in `apps/api/src/app.test.ts` and `apps/api/src/security.test.ts` can exceed vitest's 5 s default when the machine is under load (observed once on the clean `main` baseline while Docker Desktop was starting, and passing afterwards). This predates the change and is not altered here.

## Not done

- No run against the PostgreSQL-backed CRM on this machine (Docker engine would not start). The e2e test is written for that path too: start the CRM per its README, create a key with `records:read,activities:write`, set `AGENT_CRM_E2E_BASE_URL` and `AGENT_CRM_E2E_TOKEN`, and run `pnpm --filter @meeting-context-router/api exec vitest run src/crm-e2e.test.ts`.
- CI skips the e2e (no local CRM there); the skip is explicit in the test output.
- No hosted CRM was contacted.
