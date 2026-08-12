# AGENTS.md — Meeting Context Router

## Product goal

Route recorder output into governed, reviewable CRM and knowledge-system updates without hiding provenance or silently mutating important records.

## Non-negotiables

- This is not a recorder.
- n8n is not a core dependency. A generic webhook may be an optional adapter only.
- Intake is untrusted. Validate every boundary.
- No destination write happens during intake.
- Approval and delivery are separate explicit actions.
- Do not log transcripts, API tokens, webhook secrets, or authorization headers.
- Destination URLs come from administrator configuration, never meeting payloads.
- Obsidian writes must remain inside the configured root.
- Preserve source IDs and hashes so retries are idempotent.

## Stack

- TypeScript, Node.js 22+, pnpm workspaces
- Fastify API and a dependency-free browser workbench
- Zod contracts and Vitest tests
- Atomic JSON persistence for the single-instance alpha

## Commands

```bash
pnpm install
pnpm dev
pnpm typecheck
pnpm test
pnpm build
pnpm check
```

## Verification

Behavior changes require a focused test. Security-sensitive changes require tests for invalid input, duplicate/replay behavior, and failure states. Keep the public repository free of secrets and real meeting content.
