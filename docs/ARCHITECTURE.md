# Architecture

```text
Fathom / Fireflies / Granola / manual / source MCPs
              |
 webhooks, API sync, or agent MCP bridge
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

1. **Source adapters** verify authenticity where the source supports it and normalize vendor payloads. Fathom supports signed webhooks and API polling; Fireflies combines signed Webhooks V2 with a GraphQL transcript lookup; Granola uses its public notes API.
2. **Core** owns the canonical model, hashes, proposal lifecycle and authority policy.
3. **Destination adapters** receive a fixed proposal type and configured destination. They never choose an arbitrary URL or filesystem root from request input.
4. **API/workbench** exposes intake and human control. It does not contain recorder-specific domain logic.
5. **MCP bridge** lets an agent read a meeting through a vendor's official MCP and create pending router proposals. It intentionally exposes no approval or delivery tool.

## MCP composition

The router does not proxy or retain vendor OAuth sessions. An MCP-capable agent connects to an official source server and the local router bridge side by side:

```text
official Fathom / Fireflies / Granola MCP (read meeting)
                         |
                    agent context
                         |
Meeting Context Router MCP (create pending proposals only)
                         |
                    human review
```

This keeps vendor authorization in the vendor's supported OAuth flow and keeps destination authority in the router.

## Persistence

The alpha uses one atomic JSON state file and is intended for a single process. The store interface and UUID identifiers keep a future PostgreSQL migration straightforward. Multi-instance deployment is not supported yet.

## n8n boundary

n8n is neither an orchestrator nor a required runtime. A future generic webhook adapter may publish approved canonical events to n8n. That adapter will have the same proposal, allowlist, idempotency and audit rules as every other destination.
