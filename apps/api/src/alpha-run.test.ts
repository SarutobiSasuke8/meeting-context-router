import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DRY_RUN_API_KEY, REQUIRED_ENV, loadRecordedFixture, main, recordedFathomFetch, runAlphaRun, validateAlphaEnv } from "./alpha-run.js";

const roots: string[] = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function tempRoot() {
  const root = await mkdtemp(resolve(tmpdir(), "mcr-alpha-run-"));
  roots.push(root);
  return root;
}

function capture() {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, io: { stdout: (text: string) => out.push(text), stderr: (text: string) => err.push(text) } };
}

const validEnv = {
  FATHOM_API_KEY: "live-key-value-that-must-never-be-printed",
  MEETING_ROUTER_ALPHA_RECORDING_ID: "123456789",
  MEETING_ROUTER_ALPHA_CREATED_AFTER: "2026-10-20T00:00:00Z",
  MEETING_ROUTER_ALPHA_CREATED_BEFORE: "2026-10-21T00:00:00Z",
};

describe("alpha run environment validation", () => {
  it("names every missing variable and starts nothing", async () => {
    const network = vi.fn(() => { throw new Error("Network forbidden"); });
    vi.stubGlobal("fetch", network);
    const { out, err, io } = capture();
    expect(await main([], {}, io)).toBe(2);
    for (const name of REQUIRED_ENV) expect(err.join("")).toContain(`${name} is not set`);
    expect(err.join("")).toContain("pnpm alpha:run --dry-run");
    expect(out).toEqual([]);
    expect(network).not.toHaveBeenCalled();
  });

  it("rejects bad dates, an inverted window and a short key without echoing values", () => {
    const result = validateAlphaEnv({ ...validEnv, FATHOM_API_KEY: "short", MEETING_ROUTER_ALPHA_CREATED_AFTER: "20 Oct", MEETING_ROUTER_ALPHA_CREATED_BEFORE: "2026-10-19T00:00:00Z" });
    expect(result.ok).toBe(false);
    const problems = (result as { problems: string[] }).problems.join("\n");
    expect(problems).toContain("FATHOM_API_KEY looks too short");
    expect(problems).toContain("MEETING_ROUTER_ALPHA_CREATED_AFTER must be a UTC ISO date-time");
    expect(problems).not.toContain("short\n");
    const inverted = validateAlphaEnv({ ...validEnv, MEETING_ROUTER_ALPHA_CREATED_AFTER: "2026-10-22T00:00:00Z" });
    expect((inverted as { problems: string[] }).problems).toEqual(["MEETING_ROUTER_ALPHA_CREATED_AFTER must be earlier than MEETING_ROUTER_ALPHA_CREATED_BEFORE"]);
    expect(validateAlphaEnv(validEnv)).toMatchObject({ ok: true, settings: { mode: "live", recordingId: "123456789" } });
  });

  it("rejects unknown arguments", async () => {
    const { err, io } = capture();
    expect(await main(["--live"], validEnv, io)).toBe(2);
    expect(err.join("")).toContain("Usage: pnpm alpha:run [--dry-run]");
  });
});

describe("alpha run dry run (recorded Fathom API fixture)", () => {
  it("passes every automated alpha-exit criterion through the real sync route with no network", async () => {
    const root = await tempRoot();
    const network = vi.fn(() => { throw new Error("Network forbidden in the dry run"); });
    vi.stubGlobal("fetch", network);
    const { out, io } = capture();

    // A real key in the environment is ignored by the dry run.
    const code = await main(["--dry-run"], validEnv, io, { root, runId: "test" });
    const text = out.join("");
    expect(text).toContain("dry run: recorded Fathom fixture, no credentials, no network");
    for (const id of ["A1", "A2", "A3", "A4", "A5", "A6", "A7", "A8"]) expect(text).toMatch(new RegExp(`\\[PASS\\] ${id} `));
    expect(text).toContain("[MANUAL] M1 ");
    expect(text).toContain("Result: PASS (8/8 automated criteria passed)");
    expect(text).toContain("Fathom requests 4, meetings returned across intake and replay 4");
    expect(text).not.toContain(validEnv.FATHOM_API_KEY);
    expect(text).not.toContain("Synthetic transcript marker");
    expect(code).toBe(0);
    expect(network).not.toHaveBeenCalled();

    // Only the requested meeting is previewed and written; the other meeting in the window is not.
    const inbox = await readdir(resolve(root, "data/quarantine/obsidian-inbox"));
    const approved = await readdir(resolve(root, "data/quarantine/obsidian-approved"));
    expect(inbox).toHaveLength(1);
    expect(approved).toHaveLength(1);
    const note = await readFile(resolve(root, "data/quarantine/obsidian-approved", approved[0]!), "utf8");
    expect(note).toContain("Synthetic fixture: alpha prototype review");
    expect(note).not.toContain("unrelated stand-up");
    expect(await readFile(resolve(root, "data/quarantine/alpha-run-test.report.txt"), "utf8")).toBe(text.split("Report saved:")[0]);
  });

  it("fails A4 when transcript text reaches the proposal", async () => {
    const root = await tempRoot();
    const fixture = await loadRecordedFixture();
    const target = fixture.pages[1]!.items[0]! as unknown as { default_summary: { markdown_formatted: string } };
    target.default_summary.markdown_formatted += "\n\nSynthetic transcript marker: this must not appear in the proposal or the note.";
    const report = await runAlphaRun(
      { mode: "dry-run", recordingId: fixture.recordingId, createdAfter: fixture.createdAfter, createdBefore: fixture.createdBefore, fathomApiKey: DRY_RUN_API_KEY },
      { root, runId: "leak", fetchImpl: recordedFathomFetch(fixture) },
    );
    expect(report.criteria.find((criterion) => criterion.id === "A4")).toMatchObject({ status: "fail" });
    expect(report.ok).toBe(false);
  });

  it("reports a missing recording as a stopped run with a clear reason", async () => {
    const root = await tempRoot();
    const fixture = await loadRecordedFixture();
    const report = await runAlphaRun(
      { mode: "dry-run", recordingId: "999", createdAfter: fixture.createdAfter, createdBefore: fixture.createdBefore, fathomApiKey: DRY_RUN_API_KEY },
      { root, runId: "missing" },
    );
    expect(report.ok).toBe(false);
    expect(report.failure).toContain("Recording 999 was not returned for the window");
    expect(report.criteria.find((criterion) => criterion.id === "A2")).toMatchObject({ status: "not-run" });
  });

  it("judges a repeat run on its own files, leaving earlier quarantine output untouched", async () => {
    const root = await tempRoot();
    const fixture = await loadRecordedFixture();
    const settings = { mode: "dry-run" as const, recordingId: fixture.recordingId, createdAfter: fixture.createdAfter, createdBefore: fixture.createdBefore, fathomApiKey: DRY_RUN_API_KEY };
    const first = await runAlphaRun(settings, { root, runId: "one" });
    expect(first.ok).toBe(true);
    const earlier = await readFile(first.result!.quarantineProposalPath, "utf8");
    // Each run has fresh router state and its own receive time, so the second
    // run writes its own proposal and note; A7 counts only this run's files.
    const second = await runAlphaRun(settings, { root, runId: "two" });
    expect(second.ok).toBe(true);
    expect(second.criteria.find((criterion) => criterion.id === "A7")!.detail).toContain("new inbox files 1, new approved notes 1");
    expect(await readdir(resolve(root, "data/quarantine/obsidian-inbox"))).toHaveLength(2);
    expect(await readFile(first.result!.quarantineProposalPath, "utf8")).toBe(earlier);
  });
});
