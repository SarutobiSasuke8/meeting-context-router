# Security model

Meeting data can contain confidential commercial and personal information. The alpha is designed to fail closed.

## Defaults

- Production requires bearer authentication for the control API.
- CORS is disabled; the workbench is same-origin.
- Fathom signatures are checked against the raw body with constant-time comparison and a five-minute default replay window.
- Fireflies Webhooks V2 signatures are checked against the raw body with constant-time comparison; event timestamps have a five-minute default replay window.
- Fathom, Fireflies, and Granola API clients use fixed vendor origins, reject redirects, cap request time, and never accept a destination URL from meeting content.
- Request bodies are capped at 2 MiB and schemas cap collections and string lengths.
- Intake creates proposals only. Approval and delivery are separate actions.
- CRM origins and paths are configuration, not request data, reducing SSRF exposure.
- Obsidian output paths are server-generated and checked to remain inside one configured root.
- Logs exclude request bodies, authorization headers, transcripts and secrets.
- Browser code uses DOM text nodes, not HTML string injection, for meeting data.
- The MCP bridge can create pending proposals and inspect state, but exposes no approve, reject, or deliver operation.

## Before internet deployment

- Put the service behind a TLS reverse proxy with a request-size limit.
- Store secrets in the deployment secret manager, not `.env` in source control.
- Restrict the process user to the one approved output directory.
- Back up and, if required, encrypt the state store.
- Define transcript retention and deletion policy.
- Complete a threat model and recovery drill before processing client meetings.
