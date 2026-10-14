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

- Manual JSON and agent-MCP intake.
- Fathom webhook intake plus direct REST API synchronization.
- Fireflies signed Webhooks V2 with direct GraphQL transcript lookup.
- Granola public API synchronization.
- A proposal-only MCP bridge that composes with each vendor's official meeting-data MCP.
- Canonical meeting, participant, transcript, action-item and provenance schemas.
- Duplicate suppression by source meeting ID.
- Proposal queue with approve, reject and explicit deliver states.
- Working Obsidian Markdown delivery to an allowlisted output root.
- Direct CRM adapter contract with fixed configured origin, bearer auth, timeout and idempotency key.
- A deliberately honest CRM blocked state until the CRM exposes a meeting/activity endpoint.
- Local review workbench served by the API.
- JSON persistence with atomic file replacement for the single-instance alpha.

## Workspace

This repository is a pnpm workspace. The root `package.json` sets `"packageManager": "pnpm@11.16.0"` and requires Node.js 22 or newer. `pnpm-workspace.yaml` includes only `apps/*` and `packages/*`. `eval/`, `evals/`, `apps/web`, `docs/` and `workflows/` are not workspace packages.

| Path | Package | Role |
|---|---|---|
| `apps/api` | `@meeting-context-router/api` | Fastify API. Serves the review workbench. Scripts: `dev`, `build`, `typecheck`, `test`. |
| `apps/mcp` | `@meeting-context-router/mcp` | Proposal-only stdio MCP bridge. Scripts: `dev`, `build`, `typecheck`, `test`. |
| `apps/web` | none | Static workbench (`index.html`, `app.js`, `styles.css`). Not a pnpm package. |
| `packages/core` | `@meeting-context-router/core` | Canonical model, hashes and proposal lifecycle. |
| `packages/source-fathom` | `@meeting-context-router/source-fathom` | Fathom signed webhooks and API sync. |
| `packages/source-fireflies` | `@meeting-context-router/source-fireflies` | Fireflies Webhooks V2 and GraphQL transcript lookup. |
| `packages/source-granola` | `@meeting-context-router/source-granola` | Granola public notes API. |
| `packages/destination-crm` | `@meeting-context-router/destination-crm` | Direct CRM adapter. |
| `packages/destination-obsidian` | `@meeting-context-router/destination-obsidian` | Obsidian Markdown delivery. |
| `eval/` | none | Offline MCP contract suite (`eval/mcp.suite.yaml`, `eval/router-target.mjs`). |
| `evals/` | none | Written evaluation plan only (`evals/EVAL_PLAN.md`). No runner. |

Every TypeScript package under `apps/` and `packages/` defines `build` (`tsc -p tsconfig.json`), `typecheck` (`tsc --noEmit`) and `test` (`vitest run`). Root scripts fan those out with `pnpm -r --if-present`.

## Quick start

```bash
pnpm install
pnpm verify
pnpm dev
```

`pnpm dev` is `pnpm --filter @meeting-context-router/api dev`, which runs `tsx watch src/server.ts`.

Open `http://127.0.0.1:4300`. In development on loopback, the API token may be omitted. Production refuses to start without `MEETING_ROUTER_API_TOKEN`.

Import a sample meeting:

```bash
curl -X POST http://127.0.0.1:4300/v1/intake/manual \
  -H "Content-Type: application/json" \
  --data @examples/manual-meeting.json
```

Every intake creates proposals; it does not deliver them. Approve a proposal, then deliver it as a separate explicit action.

### What `pnpm verify` runs

`pnpm verify` is the check for a fresh clone, and GitHub Actions runs it on pull requests (`.github/workflows/ci.yml`). It calls three existing root scripts, in this order:

1. `pnpm typecheck`, which runs `pnpm build` and then `tsc --noEmit` in every workspace package that defines `typecheck`.
2. `pnpm test`, which runs Vitest in every workspace package that defines `test`.
3. `pnpm eval:contract`, which runs `pnpm build` and then `mcp-eval eval/mcp.suite.yaml`.

The contract suite is offline. `eval/router-target.mjs` starts the router API on a random loopback port with a throwaway state directory and a synthetic token. It does not call Fathom, Fireflies, Granola, a CRM or an Obsidian vault, and it does not read API keys or `.env`.

These are not part of `pnpm verify`:

- **Lint.** There is no ESLint configuration, and no `lint` script. The only formatter command is `pnpm format` (`prettier --write .`). `prettier --check .` fails on the current sources, golden fixtures and `pnpm-lock.yaml`. Rewriting those files would change contract fixtures and the lockfile, so verify does not run Prettier.
- **Live vendor and destination calls.** Fathom, Fireflies and Granola sync, checks against real webhook providers, and delivery to a real CRM or Obsidian vault need network access and keys (`FATHOM_API_KEY`, `FIREFLIES_API_KEY`, `GRANOLA_API_KEY`, `CRM_API_TOKEN`, and the webhook secrets). No root script runs those calls.
- **`evals/EVAL_PLAN.md`.** That file is a manual plan. It is not an executable suite.

### Other root scripts

The root `package.json` defines only these scripts:

| Command | What it does |
|---|---|
| `pnpm build` | `pnpm -r --if-present build` |
| `pnpm typecheck` | build, then `pnpm -r --if-present typecheck` |
| `pnpm test` | `pnpm -r --if-present test` |
| `pnpm check` | build, typecheck and test. No contract suite. |
| `pnpm eval:contract` | build, then the offline MCP contract suite |
| `pnpm verify` | `pnpm typecheck`, then `pnpm test`, then `pnpm eval:contract` |
| `pnpm format` | `prettier --write .` |
| `pnpm dev` | API dev server (`@meeting-context-router/api`) |

Build the MCP bridge on its own with:

```bash
pnpm --filter @meeting-context-router/mcp build
```

## Fathom

Configure Fathom to send meeting content to:

```text
POST https://your-router.example/v1/intake/fathom
```

Set `FATHOM_WEBHOOK_SECRET` to the `whsec_...` secret returned by Fathom. Verification follows Fathom's documented `webhook-id.webhook-timestamp.raw-body` HMAC-SHA256 scheme and rejects stale signatures.

Reference: [Fathom webhook documentation](https://developers.fathom.ai/webhooks).

For scheduled or manual API sync, also set `FATHOM_API_KEY` and call:

```bash
curl -X POST http://127.0.0.1:4300/v1/sources/fathom/sync \
  -H "Content-Type: application/json" \
  --data '{"maxMeetings":25}'
```

The client uses Fathom's fixed API origin and requests summaries, transcripts, and action items. Reference: [Fathom list meetings API](https://developers.fathom.ai/api-reference/meetings/list-meetings).

## Fireflies

Set `FIREFLIES_WEBHOOK_SECRET` and `FIREFLIES_API_KEY`, then configure Fireflies Webhooks V2 to send `meeting.summarized` events to:

```text
POST https://your-router.example/v1/intake/fireflies
```

The router verifies `X-Hub-Signature` over the raw body, rejects stale events, and retrieves the complete transcript from Fireflies' fixed GraphQL endpoint. `meeting.transcribed` is acknowledged but deliberately waits for the later summary event. References: [Fireflies Webhooks V2](https://docs.fireflies.ai/graphql-api/webhooks-v2) and [Transcript query](https://docs.fireflies.ai/graphql-api/query/transcript).

## Granola

Set `GRANOLA_API_KEY` and call:

```bash
curl -X POST http://127.0.0.1:4300/v1/sources/granola/sync \
  -H "Content-Type: application/json" \
  --data '{"maxNotes":25}'
```

The adapter lists accessible notes and retrieves each note with its transcript. Reference: [Granola API](https://docs.granola.ai/introduction).

## MCP composition

Fathom, Fireflies, and Granola each provide an official remote MCP for authenticated meeting data:

| Source MCP | URL | Authentication |
|---|---|---|
| Fathom | `https://api.fathom.ai/mcp` | Browser OAuth |
| Fireflies | `https://api.fireflies.ai/mcp` | OAuth or API key, depending on client |
| Granola | `https://mcp.granola.ai/mcp` | Browser OAuth |

The router's local MCP does not proxy those OAuth sessions. Connect a vendor MCP and the router MCP to the same agent. The agent reads a meeting from the vendor, then calls `meeting_router_create_proposals` with the normalized context. That tool can create pending proposals only; there is no MCP approval or delivery tool.

Build the bridge:

```bash
pnpm --filter @meeting-context-router/mcp build
```

Example client configuration:

```json
{
  "mcpServers": {
    "meeting-context-router": {
      "command": "node",
      "args": ["C:\\Dev\\Projects\\Meeting Context Router\\apps\\mcp\\dist\\stdio.js"],
      "env": {
        "ROUTER_BASE_URL": "http://127.0.0.1:4300",
        "MEETING_ROUTER_API_TOKEN": "set-in-your-client-secret-store"
      }
    }
  }
}
```

Available router tools:

- `meeting_router_status`: readiness only.
- `meeting_router_list_proposals`: read the review queue.
- `meeting_router_create_proposals`: idempotently create pending proposals from normalised meeting context.

MCP contract suite: `pnpm eval:contract` builds the workspace and runs [mcp-eval-harness](https://github.com/SarutobiSasuke8/mcp-eval-harness) against `eval/mcp.suite.yaml`. It pins the exact tool list, every input schema, golden happy paths and the proposal-first deny paths. It is offline: `eval/router-target.mjs` starts the router API on a random loopback port with throwaway state and a synthetic token. Pull requests run the same suite inside `pnpm verify` (`.github/workflows/ci.yml`) and again in the `mcp-eval` workflow.

Official setup references: [Fathom MCP](https://developers.fathom.ai/mcp-docs), [Fireflies MCP](https://docs.fireflies.ai/getting-started/mcp-configuration), and [Granola MCP](https://docs.granola.ai/help-center/sharing/integrations/mcp).

## Destination authority

| Destination | Owns | Does not receive by default |
|---|---|---|
| CRM | participant matches, meeting metadata, follow-ups, deal context | full transcript, private narrative |
| Obsidian | human-readable meeting note, decisions, context, private follow-up | CRM mutation authority |

The Obsidian adapter writes only inside `OBSIDIAN_OUTPUT_ROOT`. The default is the repository's ignored outbox, not a real vault. The CRM adapter accepts no URL from request payloads; its origin and route are administrator configuration.

## Project status

This is an early local-first alpha. See [ROADMAP.md](ROADMAP.md), [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md), and [docs/SECURITY.md](docs/SECURITY.md).
