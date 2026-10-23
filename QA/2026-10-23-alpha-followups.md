# Alpha-run follow-up verification, 23 October 2026

Synthetic recorded Fathom fixture only. No live meeting, credential path, CI YAML or ROADMAP change.

| Finding | Before | After | Regression |
|---|---|---|---|
| Summary | `## Summary` followed by another `## Summary` | one destination heading, source prose preserved | destination heading cases (plain, LF and CRLF) |
| Preview identity | fresh preview proposal ID differs from router ID | preview frontmatter and embedded note carry actual router ID | dry-run preview ID vs approved note assertion |
| Provenance | API preview says `imported manually` | `Router proposal preview from Fathom api intake` | API dry-run provenance assertion, standalone manual exporter tests unchanged |
| Independent retry | fresh per-run state and extra proposal/note | persistent quarantine state, duplicate, zero new proposal/note/report files | separate run and separate command tests; new A9 |

`pnpm alpha:run --dry-run`: 9/9 automated criteria PASS, including an independent repeat invocation. Transcript comparison: 3 long lines, zero leaked. Manual M1 remains required for the future real meeting; synthetic output is not stage-exit evidence. No dogfood checkbox changed.

Local `pnpm verify`: build, workspace typecheck, test suites and 13/13 offline MCP contracts. Initial parallel run timed out on several unrelated 5-second API cases during simultaneous game build/browser checks. All 64 API cases passed serially; after that a standard verify rerun was performed. The final separate-command test also passes and covers duplicate CLI report suppression.

State is retained at data/quarantine/alpha-exit-state.json. Existing pending/incomplete delivery stops for workbench review; it is not silently reapproved. Previous historical per-run state files are preserved and are not migrated automatically. Use the same quarantine root for subsequent invocations. Source content changes remain subject to the router's existing intake conflict rules.
