# Alpha exit: end-to-end flow

The alpha exit needs one meeting to go the whole way: a pending proposal in the
quarantined Obsidian inbox, an approval that writes the note, and a replay of
the same meeting that creates no duplicate. `apps/api/src/alpha-exit.ts` runs
that flow through the router's own HTTP routes. This complements the dogfood
runbook in #18; it does not replace it.

## What the flow does

1. **Intake.** The meeting enters the router. Fixture: a locally signed Fathom
   webhook (per-run `whsec_` secret, so the real signature check runs). Real
   meeting: `POST /v1/sources/fathom/sync` over a time window, then the run
   picks the requested recording id.
2. **Quarantine.** The dogfood preview writes the pending proposal to
   `data/quarantine/obsidian-inbox/`.
3. **Approval.** The Obsidian proposal is approved and delivered. The note is
   written to `data/quarantine/obsidian-approved/`, never to a real vault.
4. **Replay.** The same meeting goes in again. The router reports a duplicate,
   the proposal ids are unchanged, the preview refuses to overwrite, and the
   file counts stay at one.

The CRM proposal is never approved or delivered. Router state is a fresh
`data/quarantine/alpha-exit-state-<run>.json` per run. `data/quarantine/` is
gitignored.

## Fixture proof (CI)

`apps/api/src/alpha-exit.test.ts` runs the flow on
`examples/fathom-scrubbed.json` in a temporary directory, with `fetch` stubbed
to throw. It is part of `pnpm test`.

## Real meeting (owner run, not run by agents)

Preferred: `pnpm alpha:run`, which wraps this flow with environment
validation and a per-criterion pass/fail report. See
[docs/alpha-run-checklist.md](../docs/alpha-run-checklist.md); the dry run is
recorded in `QA/alpha-run-dry-run-2026-10-23.md`. The lower-level command
below still works:

```bash
FATHOM_API_KEY=... pnpm alpha-exit:fathom <recording-id> <created-after ISO> <created-before ISO>
```

Pick a window that contains the meeting, for example the day it was recorded.
The sync ingests every meeting in the window into the run's own state file, but
only the requested recording is previewed, approved and written. The command
prints paths, ids and counts only, never meeting content, and exits 0 only when
the first intake is new, the replay is a duplicate, the preview is refused on
replay, and the approved note exists.

Review the quarantined proposal and the approved note by hand before anything
moves into a real vault. If the run counts as the alpha exit, record the
output with the evidence template in the dogfood runbook (#18).
