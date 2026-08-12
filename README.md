# Meeting Context Router

Meeting Context Router takes structured outputs from meeting tools and turns them into reviewable proposals for the systems that should remember the meeting.

It is **not** a meeting recorder and it does **not** depend on n8n. Fathom, Fireflies, Granola, manual transcripts, or another source remain responsible for capture. This service owns the awkward middle: normalization, provenance, review, field authority, idempotency, and delivery to a CRM or knowledge system.

## Why this exists

Generic automation platforms can move JSON between tools. This workflow needs stronger opinions:

- one canonical meeting record across recorder vendors;
- evidence and provenance attached to every proposed update;
- no silent creation or mutation of CRM records;
- explicit approval before delivery;
- CRM operational facts kept separate from private Obsidian narrative;
- deterministic retries and idempotency rather than duplicate notes;
- direct adapters that can be tested without a visual automation runtime.

n8n or Zapier may later connect through a generic webhook adapter, but neither belongs in the core runtime.

## Current vertical slice

- Manual JSON intake.
- Fathom webhook intake with signed raw-body verification and replay tolerance.
- Canonical meeting, participant, transcript, action-item and provenance schemas.
- Duplicate suppression by source meeting ID.
- Proposal queue with approve, reject and explicit deliver states.
- Working Obsidian Markdown delivery to an allowlisted output root.
- Direct CRM adapter contract with fixed configured origin, bearer auth, timeout and idempotency key.
- A deliberately honest CRM blocked state until the CRM exposes a meeting/activity endpoint.
- Local review workbench served by the API.
- JSON persistence with atomic file replacement for the single-instance alpha.

## Quick start

```bash
pnpm install
pnpm check
pnpm dev
```

Open `http://127.0.0.1:4300`. In development on loopback, the API token may be omitted. Production refuses to start without `MEETING_ROUTER_API_TOKEN`.

Import a sample meeting:

```bash
curl -X POST http://127.0.0.1:4300/v1/intake/manual \
  -H "Content-Type: application/json" \
  --data @examples/manual-meeting.json
```

Every intake creates proposals; it does not deliver them. Approve a proposal, then deliver it as a separate explicit action.

## Fathom

Configure Fathom to send meeting content to:

```text
POST https://your-router.example/v1/intake/fathom
```

Set `FATHOM_WEBHOOK_SECRET` to the `whsec_...` secret returned by Fathom. Verification follows Fathom's documented `webhook-id.webhook-timestamp.raw-body` HMAC-SHA256 scheme and rejects stale signatures.

Reference: [Fathom webhook documentation](https://developers.fathom.ai/webhooks).

## Destination authority

| Destination | Owns | Does not receive by default |
|---|---|---|
| CRM | participant matches, meeting metadata, follow-ups, deal context | full transcript, private narrative |
| Obsidian | human-readable meeting note, decisions, context, private follow-up | CRM mutation authority |

The Obsidian adapter writes only inside `OBSIDIAN_OUTPUT_ROOT`. The default is the repository's ignored outbox, not a real vault. The CRM adapter accepts no URL from request payloads; its origin and route are administrator configuration.

## Project status

This is an early local-first alpha. See [ROADMAP.md](ROADMAP.md), [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md), and [docs/SECURITY.md](docs/SECURITY.md).
