# Security model

Meeting data can contain confidential commercial and personal information. The alpha is designed to fail closed.

## Defaults

- Production requires bearer authentication for the control API.
- CORS is disabled; the workbench is same-origin.
- Fathom signatures are checked against the raw body with constant-time comparison and a five-minute default replay window.
- Request bodies are capped at 2 MiB and schemas cap collections and string lengths.
- Intake creates proposals only. Approval and delivery are separate actions.
- CRM origins and paths are configuration, not request data, reducing SSRF exposure.
- Obsidian output paths are server-generated and checked to remain inside one configured root.
- Logs exclude request bodies, authorization headers, transcripts and secrets.
- Browser code uses DOM text nodes, not HTML string injection, for meeting data.

## Before internet deployment

- Put the service behind a TLS reverse proxy with a request-size limit.
- Store secrets in the deployment secret manager, not `.env` in source control.
- Restrict the process user to the one approved output directory.
- Back up and, if required, encrypt the state store.
- Define transcript retention and deletion policy.
- Complete a threat model and recovery drill before processing client meetings.
