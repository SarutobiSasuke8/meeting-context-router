# Dogfood runbook: one real Fathom meeting (Week 43 exit, build to alpha)

Exit criterion: one real Fathom meeting lands in the quarantined Obsidian inbox as a proposal, Alexei approves it, and a replay creates no duplicate. About 10 minutes of hands-on time.

Fathom is the source because it has a pull API. Fireflies is webhook-only and needs a public endpoint, so it is out of scope this week.

## What stays safe

- `pnpm dogfood:fathom` is offline. It reads no runtime config or keys, contacts no vendor or CRM, changes no router state and delivers nothing. It writes one file under the ignored `data/quarantine/obsidian-inbox/`.
- The proposal contains the summary and action items only, never the transcript.
- The private export file lives outside the repository. `scripts/fathom-pick.mjs` refuses to write inside it and refuses to overwrite.
- Pick a meeting with no sensitive third-party content (no client financials, health, legal or personal matters). Internal or low-stakes calls are best.

## Steps

1. Create a Fathom API key in Fathom settings (API access). Keep it in the current terminal session only:
   ```bash
   export FATHOM_API_KEY=...   # PowerShell: $env:FATHOM_API_KEY = "..."
   ```
2. List recent meetings and note the `recording_id` of the one you want:
   ```bash
   node scripts/fathom-pick.mjs list
   ```
3. Export that meeting to a folder outside the repo:
   ```bash
   node scripts/fathom-pick.mjs export <recording_id> ~/Documents/router-dogfood/fathom-<recording_id>.json
   ```
4. Run the preview:
   ```bash
   pnpm dogfood:fathom ~/Documents/router-dogfood/fathom-<recording_id>.json
   ```
   It prints `Pending quarantine proposal: <path>`. Open that file. Check the title, attendees, summary and action items read correctly and that no transcript text appears.
5. **Approve.** The offline preview has no router approval step, so approval here is a manual mark by the reviewer. In the file change `status: pending` to `status: approved` and add a line `approved_by: Alexei Udall` and `approved_on: <date>` in the frontmatter. This exit proves the proposal reached quarantine and passed human review; delivery to the vault is a separate step and is not part of this exit.
6. **Replay.** Run the same `pnpm dogfood:fathom` command again. It must fail with the "check ... whether this source already has a quarantine note" message and leave your approved file untouched. Confirm there is still exactly one `fathom-<source-hash>.proposal.md` in `data/quarantine/obsidian-inbox/`.
7. Unset the key (`unset FATHOM_API_KEY`) and, if you will not reuse the key, revoke it in Fathom.

## Evidence to paste into `QA/dogfood-fathom-YYYY-MM-DD.md`

```markdown
# Fathom dogfood, YYYY-MM-DD

Run by Alexei on <OS>, router commit `<sha>`, Node <version>. One real meeting (id `<recording_id>`; title not recorded here).

| Step | Result |
|---|---|
| Export via scripts/fathom-pick.mjs | file written outside the repo: yes / no |
| pnpm dogfood:fathom | proposal written: `fathom-<source_sha256 prefix>.proposal.md` |
| Content check | summary and action items correct: yes / no; transcript absent: yes / no |
| Approval | frontmatter set to approved by Alexei on <date> |
| Replay | second run refused, file unchanged, files in inbox: 1 |

Do not paste meeting text, attendee names or the API key into this file.
```

Then tick the dogfood item in `ROADMAP.md` and the `w43-exit-alpha` item on the control plane.

## What this does not prove

Delivery to the real vault or the Agent CRM from a Fathom source, webhook signature verification with a live Fathom secret, and the Fireflies and Granola paths. Those stay open in `ROADMAP.md`.
