# Edit a proposal before approval

In the workbench, expand **Edit before approval** on a pending proposal. Review
the title, summary, action items and target note references, then save. Saving
does not approve or deliver. Expand **Edit history** to inspect each attributed,
dated before/after revision. Reload after a concurrent edit conflict.

The equivalent API is `PATCH /v1/proposals/:id`, using the existing
`proposal:review` scope. No new principal or permission is introduced:

```json
{
  "expectedRevision": 0,
  "changes": {
    "title": "Reviewed synthetic meeting",
    "summary": "Agreed to review the draft.",
    "actionItems": [],
    "targetNotes": ["Projects/Synthetic review"]
  }
}
```

`expectedRevision` is the current `editHistory.length`, or 0 for an untouched
proposal. Changes are partial; at least one allowed field is required. Action
items use the existing canonical action-item shape. Target notes are inert
review references stored on the proposal, not filesystem destinations, CRM
routes, or permission to overwrite an existing note. They do not change the
configured delivery root or destination payload contract.

Only pending proposals can be edited. Reviewed, delivering and terminal states
return 409. The status/revision check and history append share the same atomic,
serialised store mutation as approval. Unknown fields and malformed values
return 422, matching existing API validation errors. Missing proposals return
404. Histories are bounded to 1,000 edits.

The source meeting, provenance, proposal ID and idempotency key remain unchanged.
Replaying the original intake returns the same proposals with their edits. Each
proposal is edited separately; editing a CRM proposal does not change its
Obsidian sibling. Existing stored proposals need no migration. Edit history
inherits the proposal's existing retention and encryption, and is removed with
the proposal by existing deletion handling. Audit logs record identifiers and
revision counts, not edited content. No MCP edit tool is exposed, so existing
MCP goldens remain unchanged.
