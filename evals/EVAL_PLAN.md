# Evaluation plan

- Normalize the same meeting from manual and Fathom fixtures into equivalent participants and action items.
- Reject malformed payloads and stale or invalid signatures.
- Replay an identical Fathom event and prove no duplicate meeting/proposals are created.
- Render hostile meeting text without producing executable HTML in the workbench.
- Reject an Obsidian output path that escapes the configured root.
- Prove an approved proposal still requires a separate delivery call.
- Prove CRM delivery is blocked rather than silently dropped when no CRM token is configured, when the payload does not fit the CRM contract, or when the CRM rejects the credential, route or payload.
- Deliver one meeting into a local Agent CRM end to end, check the stored record, and prove a replay of the same idempotency key returns the original record without a duplicate (`apps/api/src/crm-e2e.test.ts`, skipped when no local CRM is configured).
