# Security model

Meeting data can contain confidential commercial and personal information. The alpha is designed to fail closed.

## Defaults

- Production requires at least one authenticated principal for the control API.
- CORS is disabled; the workbench is same-origin.
- Fathom signatures are checked against the raw body with constant-time comparison and a five-minute default replay window.
- Fireflies Webhooks V2 signatures are checked against the raw body with constant-time comparison; event timestamps have a five-minute default replay window.
- Fathom, Fireflies, and Granola API clients use fixed vendor origins, reject redirects, cap request time, and never accept a destination URL from meeting content.
- Request bodies are capped at 2 MiB and schemas cap collections and string lengths.
- Intake creates proposals only. Approval and delivery are separate actions.
- CRM origins and paths are configuration, not request data. The configured base must be a bare HTTP(S) origin without credentials, the activity path must be one absolute application path (no backslashes, scheme-relative values, encoded separators, dot segments, queries, fragments, or credentials), and the resolved endpoint origin must equal the base origin. Configuration failures stop the server at startup rather than surfacing during a delivery.
- Obsidian output paths are server-generated and checked to remain inside one configured root.
- Logs exclude request bodies, authorization headers, transcripts and secrets.
- Browser code uses DOM text nodes, not HTML string injection, for meeting data.
- The MCP bridge holds its own scoped credential and cannot approve, reject, deliver, or sync even by driving the HTTP API directly.

## Principals and scopes

Every API caller authenticates as a principal with explicit scopes. Scopes: `meeting:ingest`, `meeting:read`, `proposal:read`, `proposal:review`, `proposal:deliver`, `source:sync`, `admin`. Under-scoped calls receive `403`; missing or invalid credentials receive `401`. Every intake, review, rejection, delivery, export, and deletion writes an audit log line with principal id, principal type, scopes, and request id.

Configuration:

- `MEETING_ROUTER_PRINCIPALS`: JSON array of `{ "id", "type", "token", "scopes" }` entries. Tokens are at least 24 characters and never logged or persisted in router state.
- `MEETING_ROUTER_MCP_TOKEN`: convenience variable for the MCP bridge principal (`meeting:ingest` + `proposal:read` only). Never give the bridge a reviewer or delivery credential.
- `MEETING_ROUTER_API_TOKEN`: legacy shared token, mapped to a full-authority `legacy-shared-token` principal for migration. Replace it with scoped principals and retire it.

Issuance and rotation: generate tokens with `openssl rand -base64 32`, add the new entry alongside the old one, restart, move clients over, then remove the old entry and restart again. Emergency disablement is removal of the principal entry plus a restart; tokens live only in deployment configuration, so no state cleanup is needed.

## Data minimisation and retention

Data classes: source metadata and provenance (hashes, ids, timestamps), derived operational facts (summaries, decisions, action items), private narrative (transcript segments), participant identifiers, and delivery receipts.

- Transcript retention is opt-in per deployment (`MEETING_ROUTER_RETAIN_TRANSCRIPTS`, default `false`). When off, transcript segments are dropped at the ingest boundary; the source hash still proves provenance.
- Default meeting reads return summaries and counts only; transcript text requires an explicit `includeTranscript=true` fetch on a single meeting and never appears in list responses or logs.
- `MEETING_ROUTER_MEETING_TTL_DAYS` enables the deterministic retention sweep (`POST /v1/retention/sweep`, admin scope, dry-run supported). Expired meetings are deleted with the same cascade as manual deletion.
- `DELETE /v1/meetings/:id` (admin) supports dry-run cascade reports, removes dependent proposals, deletes delivered Obsidian artifacts, and appends content-free deletion evidence (identifiers and hashes only) to an append-only log.
- `GET /v1/meetings/:id/export` (admin) returns the full meeting, its proposals, and delivery attempts for subject-access requests.
- State encryption at rest: set `MEETING_ROUTER_STATE_KEY` (32 bytes, base64). Rotation: move the old key to `MEETING_ROUTER_STATE_KEY_PREVIOUS`, set the new key, restart; the store re-encrypts on startup and the previous key can then be removed. Key material lives only in deployment configuration, never in the state file.

## Delivery integrity

- Delivery acquires a durable lease first: the attempt record (actor, idempotency key, content hash, lease expiry) and the `delivering` status are persisted before any destination side effect, so a crash can never make a completed side effect look retryable.
- Concurrent delivery of one proposal yields exactly one attempt; the loser receives `409`.
- Ambiguous CRM results (timeout or network failure mid-flight) are recorded as `unknown`, never blindly retried; reconciliation reuses the same idempotency key. The CRM endpoint is expected to honour `idempotency-key` and return a stable receipt id.
- Obsidian artifacts embed the proposal id and payload content hash. A pre-existing file counts as a prior delivery only when both match exactly; anything else is a conflict requiring review.
- Expired `delivering` leases are reconciled deterministically after restart; `GET /v1/deliveries/dead-letter` lists proposals needing operator attention.

## Before internet deployment

- Put the service behind a TLS reverse proxy with a request-size limit.
- Store secrets in the deployment secret manager, not `.env` in source control.
- Restrict the process user to the one approved output directory.
- Back up the state store; verify an encrypted backup restores with the configured key.
- Complete a threat model and recovery drill before processing client meetings.
