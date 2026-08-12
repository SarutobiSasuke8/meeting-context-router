# Workflow specification

1. Receive a trusted-source webhook or authenticated manual import.
2. Validate and normalize into the canonical meeting schema.
3. Compute a source hash and suppress replayed source IDs.
4. Create separate CRM and Obsidian proposals with evidence.
5. Human reviews and approves or rejects each proposal.
6. Human explicitly delivers an approved proposal.
7. Adapter records a delivered, blocked or failed receipt under the proposal idempotency key.

At no point does intake trigger a destination mutation.
