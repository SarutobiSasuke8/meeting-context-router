# Architecture

```text
Fathom / manual / future sources
              |
      signed + validated intake
              |
       canonical meeting record
              |
       deterministic proposals
          /             \
 CRM operational      Obsidian narrative
 proposal             proposal
          \             /
      review -> approve -> deliver
              |
    idempotent delivery receipt
```

## Boundaries

1. **Source adapters** verify authenticity where the source supports it and normalize vendor payloads.
2. **Core** owns the canonical model, hashes, proposal lifecycle and authority policy.
3. **Destination adapters** receive a fixed proposal type and configured destination. They never choose an arbitrary URL or filesystem root from request input.
4. **API/workbench** exposes intake and human control. It does not contain recorder-specific domain logic.

## Persistence

The alpha uses one atomic JSON state file and is intended for a single process. The store interface and UUID identifiers keep a future PostgreSQL migration straightforward. Multi-instance deployment is not supported yet.

## n8n boundary

n8n is neither an orchestrator nor a required runtime. A future generic webhook adapter may publish approved canonical events to n8n. That adapter will have the same proposal, allowlist, idempotency and audit rules as every other destination.
