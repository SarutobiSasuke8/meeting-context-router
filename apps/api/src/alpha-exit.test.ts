import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runAlphaExit } from "./alpha-exit.js";

const roots: string[] = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  return JSON.parse(await readFile(new URL("../../../examples/fathom-scrubbed.json", import.meta.url), "utf8"));
}

describe("alpha exit end to end (recorded Fathom fixture)", () => {
  it("quarantines a proposal, writes it on approval, and replays without a duplicate", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "mcr-alpha-exit-"));
    roots.push(root);
    const fetch = vi.fn(() => { throw new Error("Network forbidden in the fixture run"); });
    vi.stubGlobal("fetch", fetch);

    const result = await runAlphaExit({ kind: "fixture", payload: await fixture() }, root, "test");

    expect(result.sourceMeetingId).toBe("fixture-prototype-review-001");
    // Intake through the signed webhook route creates one meeting and its proposals.
    expect(result.first).toMatchObject({ status: 202, duplicate: false });
    expect(result.first.proposalIds.length).toBeGreaterThan(0);

    // The pending proposal sits in the quarantined inbox for review.
    expect(result.quarantineProposalPath).toBe(resolve(root, "data/quarantine/obsidian-inbox", result.quarantineProposalPath.split(/[\\/]/).pop()!));
    expect(await readFile(result.quarantineProposalPath, "utf8")).toContain("type: quarantined-routing-proposal\nstatus: pending");

    // The simulated approval writes the note, inside the quarantine tree only.
    expect(result.approvedNotePath.startsWith(resolve(root, "data/quarantine/obsidian-approved"))).toBe(true);
    const note = await readFile(result.approvedNotePath, "utf8");
    expect(note).toContain("# Synthetic fixture: prototype review");
    expect(note).not.toContain("Synthetic transcript marker");

    // Replay: same meeting and proposals, no new preview, no new file.
    expect(result.replay).toMatchObject({ status: 200, duplicate: true, previewRefused: true });
    expect(result.replay.proposalIds).toEqual(result.first.proposalIds);
    expect(result.counts).toEqual({ meetings: 1, proposals: result.first.proposalIds.length, quarantineFiles: 1, approvedFiles: 1 });

    // Nothing outside data/quarantine, and no network or CRM call.
    expect(await readdir(root)).toEqual(["data"]);
    expect(await readdir(resolve(root, "data"))).toEqual(["quarantine"]);
    expect(fetch).not.toHaveBeenCalled();
  });
});
