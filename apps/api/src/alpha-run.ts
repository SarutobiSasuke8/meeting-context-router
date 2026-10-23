import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { runAlphaExit, type AlphaExitResult } from "./alpha-exit.js";

// One command for the Fathom alpha run: validate the environment, ingest one
// Fathom meeting through the router's real sync route, route it, approve the
// Obsidian proposal into the quarantine tree, replay it, and print a pass/fail
// report against each alpha-exit criterion.
//
// Live mode reads FATHOM_API_KEY and the MEETING_ROUTER_ALPHA_* variables.
// Dry-run mode ignores the environment and answers the same Fathom API calls
// from a recorded, scrubbed fixture, so the same code path runs with no
// credential and no network. In both modes every request to a host other than
// api.fathom.ai is refused, so the CRM and any other system are never called.

export const REQUIRED_ENV = [
  "FATHOM_API_KEY",
  "MEETING_ROUTER_ALPHA_RECORDING_ID",
  "MEETING_ROUTER_ALPHA_CREATED_AFTER",
  "MEETING_ROUTER_ALPHA_CREATED_BEFORE",
] as const;

export const DRY_RUN_API_KEY = "dry-run-placeholder-not-a-fathom-key";
const FATHOM_ORIGIN = "https://api.fathom.ai";
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const recordedFixturePath = resolve(repositoryRoot, "examples/fathom-api-recorded.json");

export type AlphaRunMode = "live" | "dry-run";

export interface AlphaRunSettings {
  mode: AlphaRunMode;
  recordingId: string;
  createdAfter: string;
  createdBefore: string;
  fathomApiKey: string;
}

export type CriterionStatus = "pass" | "fail" | "not-run" | "manual";

export interface AlphaCriterion {
  id: string;
  title: string;
  source: string;
  status: CriterionStatus;
  detail: string;
}

export interface AlphaRunReport {
  mode: AlphaRunMode;
  ok: boolean;
  runId: string;
  root: string;
  recordingId: string;
  window: { createdAfter: string; createdBefore: string };
  fathom: { requests: number; meetingsReturned: number; transcriptLinesCompared: number; refusedRequests: number };
  criteria: AlphaCriterion[];
  failure: string | null;
  result: AlphaExitResult | null;
}

const isoDateTime = z.iso.datetime();

// Names the problem variables only. Values are never echoed.
export function validateAlphaEnv(env: NodeJS.ProcessEnv): { ok: true; settings: AlphaRunSettings } | { ok: false; problems: string[] } {
  const value = (name: (typeof REQUIRED_ENV)[number]) => env[name]?.trim() ?? "";
  const missing = REQUIRED_ENV.filter((name) => !value(name));
  const problems = missing.map((name) => `${name} is not set`);
  const key = value("FATHOM_API_KEY");
  if (key && key.length < 16) problems.push("FATHOM_API_KEY looks too short to be a Fathom API key (at least 16 characters expected)");
  const after = value("MEETING_ROUTER_ALPHA_CREATED_AFTER");
  const before = value("MEETING_ROUTER_ALPHA_CREATED_BEFORE");
  for (const [name, candidate] of [["MEETING_ROUTER_ALPHA_CREATED_AFTER", after], ["MEETING_ROUTER_ALPHA_CREATED_BEFORE", before]] as const) {
    if (candidate && !isoDateTime.safeParse(candidate).success) problems.push(`${name} must be a UTC ISO date-time such as 2026-10-16T00:00:00Z`);
  }
  if (isoDateTime.safeParse(after).success && isoDateTime.safeParse(before).success && Date.parse(after) >= Date.parse(before)) {
    problems.push("MEETING_ROUTER_ALPHA_CREATED_AFTER must be earlier than MEETING_ROUTER_ALPHA_CREATED_BEFORE");
  }
  const recordingId = value("MEETING_ROUTER_ALPHA_RECORDING_ID");
  if (recordingId && !/^[A-Za-z0-9_-]{1,100}$/.test(recordingId)) problems.push("MEETING_ROUTER_ALPHA_RECORDING_ID must be the numeric recording_id from Fathom (letters, digits, - and _ only)");
  if (problems.length) return { ok: false, problems };
  return { ok: true, settings: { mode: "live", recordingId, createdAfter: after, createdBefore: before, fathomApiKey: key } };
}

interface RecordedFixture {
  recordingId: string;
  createdAfter: string;
  createdBefore: string;
  pages: Array<{ limit: number | null; next_cursor: string | null; items: Array<Record<string, unknown> & { created_at: string }> }>;
}

export async function loadRecordedFixture(path = recordedFixturePath): Promise<RecordedFixture> {
  return JSON.parse(await readFile(path, "utf8")) as RecordedFixture;
}

// Answers Fathom's list-meetings endpoint from the recorded pages, honouring
// the cursor and the created_after/created_before filters the way the API does.
export function recordedFathomFetch(fixture: RecordedFixture): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.origin !== FATHOM_ORIGIN || url.pathname !== "/external/v1/meetings") throw new Error("The recorded fixture only answers the Fathom list-meetings endpoint");
    const headers = new Headers(init?.headers);
    if (headers.get("x-api-key") !== DRY_RUN_API_KEY) return new Response(JSON.stringify({ error: "unauthorised" }), { status: 401 });
    const cursor = url.searchParams.get("cursor");
    const index = cursor ? fixture.pages.findIndex((_, position) => fixture.pages[position - 1]?.next_cursor === cursor) : 0;
    if (index < 0) return new Response(JSON.stringify({ error: "unknown cursor" }), { status: 400 });
    const page = fixture.pages[index]!;
    const after = url.searchParams.get("created_after");
    const before = url.searchParams.get("created_before");
    const items = page.items.filter((item) => (!after || Date.parse(item.created_at) >= Date.parse(after)) && (!before || Date.parse(item.created_at) < Date.parse(before)));
    return new Response(JSON.stringify({ ...page, items }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
}

interface FetchObservation { requests: number; refused: number; meetings: number; transcriptLines: Set<string> }

// Pass-through observer: refuses every host except Fathom and keeps the
// transcript lines it sees in memory only, for the transcript-absence check.
function observeFathom(inner: typeof fetch, observation: FetchObservation): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.origin !== FATHOM_ORIGIN) {
      observation.refused += 1;
      throw new Error("The alpha run only talks to the Fathom API");
    }
    observation.requests += 1;
    const response = await inner(input, init);
    try {
      const body = (await response.clone().json()) as { items?: Array<{ transcript?: Array<{ text?: unknown }> | null }> };
      for (const item of body.items ?? []) {
        observation.meetings += 1;
        for (const segment of item.transcript ?? []) if (typeof segment.text === "string") observation.transcriptLines.add(segment.text.trim());
      }
    } catch {
      // Non-JSON or error bodies are left for the router to handle.
    }
    return response;
  }) as typeof fetch;
}

async function listFiles(path: string) {
  return readdir(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return [] as string[];
    throw error;
  });
}

function inside(child: string, parent: string) {
  return resolve(child).startsWith(resolve(parent) + sep);
}

function explain(error: unknown, settings: AlphaRunSettings) {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  const message = error instanceof Error ? error.message.slice(0, 200) : "unknown error";
  if (code === "EEXIST") return "A quarantine proposal for this meeting already exists in data/quarantine/obsidian-inbox/ from an earlier run. Move that file out of the folder (keep it if it carries review notes), then run again.";
  if (message.includes("not in the Fathom sync window")) return `Recording ${settings.recordingId} was not returned for the window ${settings.createdAfter} to ${settings.createdBefore}. Check the recording_id and widen the window (the sync reads at most 100 meetings).`;
  if (message.includes("Fathom sync returned 502")) return "The Fathom API call failed. Check that FATHOM_API_KEY is valid and that this machine can reach api.fathom.ai.";
  return message;
}

const CRITERIA: Array<Pick<AlphaCriterion, "id" | "title" | "source">> = [
  { id: "A1", title: "Environment is complete and valid", source: "docs/alpha-run-checklist.md" },
  { id: "A2", title: "Requested Fathom meeting is ingested or recognised as duplicate through the sync route", source: "QA/ALPHA_EXIT_E2E.md step 1" },
  { id: "A3", title: "Pending proposal lands in the quarantined Obsidian inbox", source: "ROADMAP.md dogfood item; QA/DOGFOOD_RUNBOOK.md exit criterion" },
  { id: "A4", title: "No transcript text in the proposal or the approved note", source: "QA/DOGFOOD_RUNBOOK.md step 4" },
  { id: "A5", title: "Approval delivers the note inside the quarantine tree only", source: "QA/ALPHA_EXIT_E2E.md step 3" },
  { id: "A6", title: "Replay is a duplicate: same proposal ids, no new meeting or proposal", source: "QA/ALPHA_EXIT_E2E.md step 4; QA/DOGFOOD_RUNBOOK.md step 6" },
  { id: "A7", title: "Replay preserves artifacts: new files only on first intake", source: "QA/ALPHA_EXIT_E2E.md step 4; QA/DOGFOOD_RUNBOOK.md step 6" },
  { id: "A8", title: "CRM proposal stays pending and no host other than Fathom is called", source: "QA/ALPHA_EXIT_E2E.md (CRM never approved or delivered)" },
  { id: "A9", title: "Independent repeat invocation is duplicate and writes no new files", source: "docs/alpha-run-checklist.md" },
  { id: "M1", title: "Human review: title, attendees, summary and action items read correctly", source: "QA/DOGFOOD_RUNBOOK.md steps 4 and 5" },
];

export async function runAlphaRun(settings: AlphaRunSettings, options: { root: string; runId?: string; fetchImpl?: typeof fetch }): Promise<AlphaRunReport> {
  const runId = options.runId ?? new Date().toISOString().replace(/[:.]/g, "-");
  const inbox = resolve(options.root, "data/quarantine/obsidian-inbox");
  const approvedRoot = resolve(options.root, "data/quarantine/obsidian-approved");
  const before = { inbox: await listFiles(inbox), approved: await listFiles(approvedRoot) };
  const observation: FetchObservation = { requests: 0, refused: 0, meetings: 0, transcriptLines: new Set() };
  const inner = options.fetchImpl ?? (settings.mode === "dry-run" ? recordedFathomFetch(await loadRecordedFixture()) : globalThis.fetch);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = observeFathom(inner, observation);

  let result: AlphaExitResult | null = null;
  let failure: string | null = null;
  try {
    result = await runAlphaExit({ kind: "fathom-api", meetingId: settings.recordingId, fathomApiKey: settings.fathomApiKey, createdAfter: settings.createdAfter, createdBefore: settings.createdBefore }, options.root, runId);
  } catch (error) {
    failure = explain(error, settings);
  } finally {
    globalThis.fetch = originalFetch;
  }

  const results = new Map<string, Pick<AlphaCriterion, "status" | "detail">>();
  results.set("A1", { status: "pass", detail: settings.mode === "dry-run" ? "dry run: environment ignored, placeholder key used" : `${REQUIRED_ENV.length} required variables set and valid` });
  const linesCompared = [...observation.transcriptLines].filter((line) => line.length >= 30);
  if (result) {
    const r = result;
    const proposal = await readFile(r.quarantineProposalPath, "utf8").catch(() => null);
    const note = await readFile(r.approvedNotePath, "utf8").catch(() => null);
    const after = { inbox: await listFiles(inbox), approved: await listFiles(approvedRoot) };
    const newInbox = after.inbox.filter((name) => !before.inbox.includes(name)).length;
    const newApproved = after.approved.filter((name) => !before.approved.includes(name)).length;
    const check = (ok: boolean, detail: string) => ({ status: (ok ? "pass" : "fail") as CriterionStatus, detail });

    results.set("A2", check(r.first.status === 202 && r.first.proposalIds.length > 0 && r.sourceMeetingId === settings.recordingId,
      `sync status ${r.first.status}, duplicate ${r.first.duplicate}, ${r.first.proposalIds.length} proposals, ${r.countsAfterFirst.meetings} meetings in the window`));
    results.set("A3", check(proposal !== null && inside(r.quarantineProposalPath, inbox) && proposal.includes("type: quarantined-routing-proposal\nstatus: pending"),
      `data/quarantine/obsidian-inbox/${r.quarantineProposalPath.split(/[\\/]/).pop()}`));
    const leaked = linesCompared.filter((line) => proposal?.includes(line) || note?.includes(line)).length;
    results.set("A4", check(proposal !== null && note !== null && leaked === 0,
      linesCompared.length ? `${linesCompared.length} transcript lines compared, ${leaked} found` : "Fathom returned no transcript lines of 30+ characters; nothing to compare, confirm by eye in M1"));
    results.set("A5", check(note !== null && inside(r.approvedNotePath, approvedRoot) && r.proposalStatuses.obsidian === "delivered",
      `obsidian proposal ${r.proposalStatuses.obsidian ?? "missing"}, note data/quarantine/obsidian-approved/${r.approvedNotePath.split(/[\\/]/).pop()}`));
    const sameIds = JSON.stringify([...r.replay.proposalIds].sort()) === JSON.stringify([...r.first.proposalIds].sort());
    results.set("A6", check(r.replay.duplicate && sameIds && r.counts.meetings === r.countsAfterFirst.meetings && r.counts.proposals === r.countsAfterFirst.proposals,
      `replay duplicate ${r.replay.duplicate}, proposal ids unchanged ${sameIds}, meetings ${r.countsAfterFirst.meetings} -> ${r.counts.meetings}, proposals ${r.countsAfterFirst.proposals} -> ${r.counts.proposals}`));
    results.set("A7", check(r.replay.previewRefused && newInbox === (r.first.duplicate ? 0 : 1) && newApproved === (r.first.duplicate ? 0 : 1),
      `preview refused ${r.replay.previewRefused}, new inbox files ${newInbox}, new approved notes ${newApproved}`));
    results.set("A8", check(r.proposalStatuses.crm === "pending" && observation.refused === 0,
      `crm proposal ${r.proposalStatuses.crm ?? "missing"}, ${observation.requests} Fathom requests, ${observation.refused} other requests refused`));
    const repeatBefore = { inbox: await listFiles(inbox), approved: await listFiles(approvedRoot) };
    globalThis.fetch = observeFathom(inner, observation);
    let repeat: AlphaExitResult;
    try { repeat = await runAlphaExit({ kind: "fathom-api", meetingId: settings.recordingId, fathomApiKey: settings.fathomApiKey, createdAfter: settings.createdAfter, createdBefore: settings.createdBefore }, options.root, `${runId}-repeat`); } finally { globalThis.fetch = originalFetch; }
    const repeatAfter = { inbox: await listFiles(inbox), approved: await listFiles(approvedRoot) };
    results.set("A9", check(repeat.first.duplicate && JSON.stringify(repeat.first.proposalIds) === JSON.stringify(r.first.proposalIds) && JSON.stringify(repeatBefore) === JSON.stringify(repeatAfter),
      `independent invocation duplicate ${repeat.first.duplicate}, no new inbox or approved files ${JSON.stringify(repeatBefore) === JSON.stringify(repeatAfter)}`));

  }
  results.set("M1", { status: "manual", detail: result ? "open the inbox file and the approved note and read them" : "not reached" });

  const criteria = CRITERIA.map((criterion) => ({ ...criterion, ...(results.get(criterion.id) ?? { status: "not-run" as const, detail: "not reached" }) }));
  const ok = failure === null && criteria.every((criterion) => criterion.status === "pass" || criterion.status === "manual");
  return {
    mode: settings.mode,
    ok,
    runId,
    root: options.root,
    recordingId: settings.recordingId,
    window: { createdAfter: settings.createdAfter, createdBefore: settings.createdBefore },
    fathom: { requests: observation.requests, meetingsReturned: observation.meetings, transcriptLinesCompared: linesCompared.length, refusedRequests: observation.refused },
    criteria,
    failure,
    result,
  };
}

function commit(root: string) {
  try {
    return execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return "unknown";
  }
}

// Paths, ids, counts and statuses only: never meeting content.
export function formatAlphaRunReport(report: AlphaRunReport, meta: { commit: string; node: string }) {
  const label: Record<CriterionStatus, string> = { pass: "PASS", fail: "FAIL", "not-run": "NOT RUN", manual: "MANUAL" };
  const automated = report.criteria.filter((criterion) => criterion.status !== "manual");
  const passed = automated.filter((criterion) => criterion.status === "pass").length;
  return [
    `Meeting Context Router alpha run (${report.mode === "dry-run" ? "dry run: recorded Fathom fixture, no credentials, no network" : "live: Fathom API"})`,
    `Run ${report.runId} | commit ${meta.commit} | Node ${meta.node}`,
    `Recording ${report.recordingId} | window ${report.window.createdAfter} to ${report.window.createdBefore}`,
    `Fathom requests ${report.fathom.requests}, meetings returned across intake and replay ${report.fathom.meetingsReturned}, other requests refused ${report.fathom.refusedRequests}`,
    "",
    ...report.criteria.map((criterion) => `[${label[criterion.status]}] ${criterion.id} ${criterion.title}\n         ${criterion.detail}`),
    "",
    ...(report.failure ? [`Run stopped: ${report.failure}`, ""] : []),
    `Result: ${report.ok ? "PASS" : "FAIL"} (${passed}/${automated.length} automated criteria passed). M1 is a manual check${report.result ? `: read ${report.result.quarantineProposalPath} and ${report.result.approvedNotePath}` : ""}.`,
  ].join("\n");
}

export interface AlphaRunIo { stdout: (text: string) => void; stderr: (text: string) => void }

// Exit codes: 0 all automated criteria pass, 1 a criterion failed, 2 the
// environment or arguments are invalid (nothing was run).
export async function main(argv: string[], env: NodeJS.ProcessEnv, io: AlphaRunIo, overrides: { root?: string; runId?: string } = {}): Promise<number> {
  const unknown = argv.filter((arg) => arg !== "--dry-run");
  if (unknown.length) {
    io.stderr("Usage: pnpm alpha:run [--dry-run]\nSet the variables in docs/alpha-run-checklist.md first; --dry-run needs none.\n");
    return 2;
  }
  const dryRun = argv.includes("--dry-run") || env.MEETING_ROUTER_ALPHA_DRY_RUN === "true";
  let settings: AlphaRunSettings;
  if (dryRun) {
    const fixture = await loadRecordedFixture();
    settings = { mode: "dry-run", recordingId: fixture.recordingId, createdAfter: fixture.createdAfter, createdBefore: fixture.createdBefore, fathomApiKey: DRY_RUN_API_KEY };
  } else {
    const validation = validateAlphaEnv(env);
    if (!validation.ok) {
      io.stderr(`Alpha run not started. Fix the environment first:\n${validation.problems.map((problem) => `  - ${problem}`).join("\n")}\nSee docs/alpha-run-checklist.md. To try the flow without credentials: pnpm alpha:run --dry-run\n`);
      return 2;
    }
    settings = validation.settings;
  }
  const root = overrides.root ?? (dryRun ? await mkdtemp(resolve(tmpdir(), "mcr-alpha-dry-run-")) : repositoryRoot);
  const report = await runAlphaRun(settings, { root, ...(overrides.runId ? { runId: overrides.runId } : {}) });
  const text = formatAlphaRunReport(report, { commit: commit(repositoryRoot), node: process.version });
  io.stdout(`${text}\n`);
  // Keep a copy beside the quarantine output so it can be sent back as is.
  const reportPath = resolve(root, "data/quarantine", `alpha-run-${report.runId}.report.txt`);
  if (report.result?.first.duplicate) return report.ok ? 0 : 1;
  await mkdir(dirname(reportPath), { recursive: true });
  await writeFile(reportPath, `${text}\n`, { encoding: "utf8", flag: "wx" }).then(() => io.stdout(`Report saved: ${reportPath}\n`), () => undefined);
  return report.ok ? 0 : 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2), process.env, {
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
  });
}
