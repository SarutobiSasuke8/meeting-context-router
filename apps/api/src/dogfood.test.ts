import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { previewFathomExport } from "./dogfood.js";

const roots: string[] = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function temporaryRoot() {
  const root = await mkdtemp(resolve(tmpdir(), "mcr-dogfood-"));
  roots.push(root);
  return root;
}
async function fixture() {
  return JSON.parse(await readFile(new URL("../../../examples/fathom-scrubbed.json", import.meta.url), "utf8"));
}

describe("offline Fathom dogfood", () => {
  it("writes only a pending quarantine proposal using the real normaliser and renderer", async () => {
    const root = await temporaryRoot();
    const fetch = vi.fn(() => { throw new Error("Network forbidden in offline preview"); });
    vi.stubGlobal("fetch", fetch);
    const result = await previewFathomExport(await fixture(), root);
    expect(result.path).toBe(resolve(root, "data/quarantine/obsidian-inbox", `fathom-${result.sourceHash}.proposal.md`));
    expect(result.proposal).toMatchObject({ target: "obsidian", status: "pending", reviewedAt: null, deliveredAt: null });
    const note = await readFile(result.path, "utf8");
    expect(note).toContain("type: quarantined-routing-proposal\nstatus: pending");
    expect(note).toContain("dry_run: true");
    expect(note).toContain('source_meeting_id: "fixture-prototype-review-001"');
    expect(note).toContain(`source_sha256: "${result.sourceHash}"`);
    expect(note).toContain("# Synthetic fixture: prototype review");
    expect(note).toContain("- [ ] Review the quarantined prototype proposal");
    expect(note).not.toContain("Synthetic transcript marker");
    expect(await readdir(root)).toEqual(["data"]);
    expect(await readdir(resolve(root, "data"))).toEqual(["quarantine"]);
    expect(await readdir(resolve(root, "data/quarantine/obsidian-inbox"))).toHaveLength(1);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects invalid exports before creating any output", async () => {
    const root = await temporaryRoot();
    await expect(previewFathomExport({ title: "Incomplete export" }, root)).rejects.toThrow();
    expect(await readdir(root)).toEqual([]);
  });

  it("refuses repeated input and preserves an operator-edited proposal", async () => {
    const root = await temporaryRoot();
    const input = await fixture();
    const result = await previewFathomExport(input, root);
    await writeFile(result.path, "Operator review: preserve this text", "utf8");
    await expect(previewFathomExport(input, root)).rejects.toMatchObject({ code: "EEXIST" });
    expect(await readFile(result.path, "utf8")).toBe("Operator review: preserve this text");
    expect(await readdir(resolve(root, "data/quarantine/obsidian-inbox"))).toHaveLength(1);
  });
});
