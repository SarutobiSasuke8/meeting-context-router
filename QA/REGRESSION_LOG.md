# Regression log

Record failures that should never recur. Each entry should name the symptom, root cause, guardrail and test.

## 2026-10-04 - MCR-05: edited Obsidian notes accepted or deleted

- **Symptom:** A note whose body had been edited but whose router metadata was unchanged counted as a successful delivery on retry. Manual deletion and retention could also remove the edited note.
- **Root cause:** Retry verification compared only embedded proposal id and payload hash. Cleanup checked path containment but did not verify file contents or ownership.
- **Guardrail:** Compare the complete note bytes with the rendered proposal and refuse symbolic links or non-regular targets. Cleanup conflicts return `409 artifact_conflict` before removing that meeting's state. Missing artifacts remain idempotent; unchanged notes can still be reconciled and removed.
- **Tests:** `apps/api/src/security.test.ts` reproduces edited-body retry, deletion and retention failures and verifies preserved notes, proposals and deletion evidence. `packages/destination-obsidian/src/index.test.ts` covers exact retries, repeated deletion, edited/replaced/truncated notes, directories and symbolic links. These cases use synthetic temporary files only.

## 2026-08-13 — MCR-01: CRM destination URL escape

- **Symptom:** A crafted `CRM_MEETING_ACTIVITY_PATH` value (reproduced with `/\evil.example`) could resolve the delivery endpoint onto a different origin than the configured CRM base, sending the meeting payload and bearer token off-site.
- **Root cause:** The activity path was joined onto the base URL without validating the resolved result; `new URL()` treats backslashes, scheme-relative values, encoded separators, and dot segments as navigation, so the "path" could rewrite host or scheme.
- **Guardrail:** `validateCrmDestination` (fixed in 5aa6aaf) enforces a bare-origin base without credentials and a single absolute application path — no backslashes, scheme-relative values, encoded separators, dot segments, queries, fragments, or credentials — and requires the resolved endpoint origin to equal the base origin. Invalid config stops startup.
- **Test:** Table-driven cases in `packages/destination-crm/src/index.test.ts` with a fetch spy proving no request or bearer header is ever emitted for rejected values, including the reproduced `/\evil.example` escape ("never sends the bearer token when the endpoint is rejected", "accepts valid same-origin paths and keeps the request on the configured origin").

## 2026-08-13 — MCR-02: single shared token, no scoping

- **Symptom:** Every caller, including the MCP bridge, authenticated with one shared token that could review, deliver, sync, and administer — a compromised bridge credential meant full control of the router.
- **Root cause:** Authentication existed but authorization did not: there was no principal model, so the enforcement boundary could not distinguish an ingest-only client from an operator.
- **Guardrail:** Scoped principals (`meeting:ingest`/`meeting:read`, `proposal:read`/`proposal:review`/`proposal:deliver`, `source:sync`, `admin`) replace the shared token (5aa6aaf). The MCP bridge gets its own limited credential; under-scoped calls get 403, unauthenticated calls get 401, and audit log lines carry principal id, type, scopes, and request id.
- **Test:** Authorization-matrix test in `apps/api/src/security.test.ts` ("rejects missing tokens with 401 and under-scoped principals with 403") proving the bridge principal cannot review, deliver, sync, or admin over HTTP.

## 2026-08-13 — MCR-03: transcripts retained by default, unencrypted, forever

- **Symptom:** Full meeting transcripts were stored on every ingest, returned in list responses, kept indefinitely, and persisted as plaintext JSON on disk.
- **Root cause:** No retention or data-minimisation design: the canonical meeting model carried the transcript everywhere the meeting went, and the state file had no encryption layer.
- **Guardrail:** Transcripts are opt-in at ingest (default dropped), list responses exclude transcript text, per-meeting fetch requires an explicit include flag, a TTL-based retention sweep removes expired meetings, deletion cascades with artifact cleanup and content-free append-only evidence, and the state file supports AES-256-GCM encryption with documented key rotation and v1→v2 migration (5aa6aaf).
- **Test:** `apps/api/src/security.test.ts` — "drops transcripts at ingest by default and keeps them only when opted in", "sweeps expired meetings deterministically when a TTL is configured", "deletes a meeting with cascade, artifact cleanup, and content-free evidence", "encrypts state at rest and survives key rotation", "migrates schema v1 state files in place".

## 2026-08-13 — MCR-04: non-atomic delivery, blind retries after crash

- **Symptom:** Two concurrent deliver calls could both reach the destination adapter, and a crash mid-delivery left a proposal that would be blindly retried even though the side effect (CRM POST, Obsidian file) may already have landed — duplicating records.
- **Root cause:** Delivery mutated status only after the side effect, with no lease, no durable attempt record, and no distinction between "failed before the request" and "outcome unknown".
- **Guardrail:** Delivery acquires a persisted lease and attempt record before any side effect; attempts store actor, idempotency key, content hash, lease expiry, receipt id, and bounded error; ambiguous CRM results become `unknown` and require reconciliation; Obsidian artifacts embed proposal id and content hash so an EEXIST collision succeeds only on an exact match; expired leases reconcile deterministically after restart; a dead-letter view surfaces stuck proposals (5aa6aaf).
- **Test:** `apps/api/src/security.test.ts` — "persists the attempt before the side effect and refuses concurrent delivery", "recovers an expired delivering lease deterministically after restart", "treats a wrong pre-existing artifact as a conflict, never silent success", "returns alreadyExisted only for an exact prior delivery of the same proposal".
