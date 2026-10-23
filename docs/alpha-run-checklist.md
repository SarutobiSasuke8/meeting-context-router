# Alpha run checklist: one real Fathom meeting

This is the single command for the Fathom alpha exit. It ingests one Fathom meeting through the router's real sync route, routes it, writes a pending proposal to the quarantined Obsidian inbox, approves and delivers the Obsidian proposal into the quarantine tree, replays the meeting, and prints a pass/fail report against each alpha-exit criterion. About 5 minutes of hands-on time.

Background: [QA/ALPHA_EXIT_E2E.md](../QA/ALPHA_EXIT_E2E.md) (the flow) and [QA/DOGFOOD_RUNBOOK.md](../QA/DOGFOOD_RUNBOOK.md) (the exit criterion and safety rules).

## What stays safe

- Everything is written under `data/quarantine/` in the repository, which is gitignored. Nothing goes to your real vault.
- The CRM proposal is never approved or delivered. The run refuses any request to a host other than `api.fathom.ai`.
- Router state is a fresh file per run (`data/quarantine/alpha-exit-state-<run>.json`). Your normal `data/state.json` is not read or changed.
- Transcripts are dropped at the ingest boundary and never written to the proposal or the note. The run checks this (criterion A4).
- The report prints ids, paths, counts and statuses only. It never prints the API key or meeting text.
- Pick a low-stakes internal meeting with no client financials, health, legal or personal matters.

## 1. Try it first without credentials

```bash
pnpm alpha:run --dry-run
```

This answers the same Fathom API calls from the recorded, scrubbed fixture `examples/fathom-api-recorded.json`. It needs no variables, ignores any you have set, makes no network call, and writes to a temporary folder. It should end with `Result: PASS (9/9 automated criteria passed)`.

## 2. Set the environment variables

Set these in the current terminal session only. Do not put them in `.env` or any committed file.

| Variable | What it is |
|---|---|
| `FATHOM_API_KEY` | A Fathom API key (Fathom settings, API access). |
| `MEETING_ROUTER_ALPHA_RECORDING_ID` | The `recording_id` of the meeting to use. `node scripts/fathom-pick.mjs list` shows recent ones. |
| `MEETING_ROUTER_ALPHA_CREATED_AFTER` | Start of a window that contains the meeting, UTC ISO date-time, for example `2026-10-22T00:00:00Z`. |
| `MEETING_ROUTER_ALPHA_CREATED_BEFORE` | End of the window, later than the start, for example `2026-10-23T00:00:00Z`. |

The window filters on the meeting's `created_at` in Fathom, which can differ from the scheduled start. The day the meeting was recorded is usually right; if the run says the recording was not returned, widen the window by a day either side. Every meeting in the window is ingested into the run's own state file (up to 100), but only the requested recording is previewed, approved and written.

PowerShell:

```powershell
$env:FATHOM_API_KEY = "<your key>"
$env:MEETING_ROUTER_ALPHA_RECORDING_ID = "<recording_id>"
$env:MEETING_ROUTER_ALPHA_CREATED_AFTER = "<start, e.g. 2026-10-22T00:00:00Z>"
$env:MEETING_ROUTER_ALPHA_CREATED_BEFORE = "<end, e.g. 2026-10-23T00:00:00Z>"
```

Bash:

```bash
export FATHOM_API_KEY=... MEETING_ROUTER_ALPHA_RECORDING_ID=... MEETING_ROUTER_ALPHA_CREATED_AFTER=... MEETING_ROUTER_ALPHA_CREATED_BEFORE=...
```

## 3. Run it

```bash
pnpm alpha:run
```

If a variable is missing or malformed, nothing runs. The command exits with code 2 and names each problem variable, for example:

```text
Alpha run not started. Fix the environment first:
  - MEETING_ROUTER_ALPHA_RECORDING_ID is not set
  - MEETING_ROUTER_ALPHA_CREATED_AFTER must be a UTC ISO date-time such as 2026-10-16T00:00:00Z
```

## 4. Expected output

```text
Meeting Context Router alpha run (live: Fathom API)
Run <run id> | commit <sha> | Node <version>
Recording <recording_id> | window <start> to <end>
Fathom requests <n>, meetings returned across intake and replay <n>, other requests refused 0

[PASS] A1 Environment is complete and valid
[PASS] A2 Requested Fathom meeting is ingested or recognised as duplicate through the sync route
[PASS] A3 Pending proposal lands in the quarantined Obsidian inbox
[PASS] A4 No transcript text in the proposal or the approved note
[PASS] A5 Approval delivers the note inside the quarantine tree only
[PASS] A6 Replay is a duplicate: same proposal ids, no new meeting or proposal
[PASS] A7 Replay preserves artifacts: new files only on first intake
[PASS] A8 CRM proposal stays pending and no host other than Fathom is called
[PASS] A9 Independent repeat invocation is duplicate and writes no new files
[MANUAL] M1 Human review: title, attendees, summary and action items read correctly

Result: PASS (9/9 automated criteria passed). M1 is a manual check: read <inbox file> and <approved note>.
Report saved: <repo>/data/quarantine/alpha-run-<run id>.report.txt
```

Each criterion has a detail line under it. Exit code 0 means every automated criterion passed, 1 means at least one failed or the run stopped (the reason is printed as `Run stopped: ...`), and 2 means the environment was invalid.

| Criterion | Source |
|---|---|
| A1 environment | this checklist |
| A2 intake | QA/ALPHA_EXIT_E2E.md step 1 |
| A3 quarantine | ROADMAP.md dogfood item; QA/DOGFOOD_RUNBOOK.md exit criterion |
| A4 no transcript | QA/DOGFOOD_RUNBOOK.md step 4 |
| A5 approval writes note | QA/ALPHA_EXIT_E2E.md step 3 |
| A6 replay duplicate | QA/ALPHA_EXIT_E2E.md step 4; QA/DOGFOOD_RUNBOOK.md step 6 |
| A7 no overwrite | QA/ALPHA_EXIT_E2E.md step 4; QA/DOGFOOD_RUNBOOK.md step 6 |
| A8 CRM untouched | QA/ALPHA_EXIT_E2E.md |
| A9 independent repeat | same recording and quarantine root, no new artifacts |
| M1 human review | QA/DOGFOOD_RUNBOOK.md steps 4 and 5 |

## 5. Do the manual check (M1)

Open the two files named on the `Result:` line. Check the title, attendees, summary and action items read correctly and that no transcript text appears. The note has one Summary heading. The quarantine preview uses the router proposal ID and names its actual Fathom intake transport.

## 6. Clean up

```powershell
Remove-Item Env:FATHOM_API_KEY, Env:MEETING_ROUTER_ALPHA_RECORDING_ID, Env:MEETING_ROUTER_ALPHA_CREATED_AFTER, Env:MEETING_ROUTER_ALPHA_CREATED_BEFORE
```

Revoke the Fathom key if you will not reuse it. Router state is retained in `data/quarantine/alpha-exit-state.json`. Repeating the same recording against the same root reports duplicate and creates no new proposal, note or report file. Existing reviewed artifacts are preserved. A pending or incomplete prior delivery stops for workbench review rather than being approved again. Dry runs use a temporary root and prove a second independent invocation against that root (A9).

## What to send back

1. The saved report file `data/quarantine/alpha-run-<run id>.report.txt`, or the terminal output from the first line to the `Result:` line. It contains ids, paths, counts and statuses only.
2. Your M1 verdict in one line: `M1: pass` or `M1: fail, <what was wrong>` (describe the problem, do not paste meeting text).
3. Your OS.

Do not send the API key, the proposal or note contents, attendee names, or the state file. If the run stopped, send the `Run stopped:` line as well.

## What this does not prove

Delivery to your real vault or the Agent CRM from a Fathom source, webhook signature verification with a live Fathom webhook secret, and the Fireflies and Granola paths. Those stay open in `ROADMAP.md`.
