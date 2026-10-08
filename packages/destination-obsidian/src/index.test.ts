import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { RoutingProposal } from "@meeting-context-router/core";
import { deliverObsidianProposal, ObsidianArtifactConflictError, removeObsidianArtifact, renderObsidianMeeting } from "./index.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixtureRoot() {
  const root = await mkdtemp(join(tmpdir(), "meeting-obsidian-artifact-"));
  roots.push(root);
  return root;
}

const proposal: RoutingProposal = {
  id: "1af954b7-3949-4231-a9d4-b4cbf992fdb8",
  meetingId: "90a21496-abf2-43e2-a10f-94267228afd4",
  target: "obsidian",
  operation: "write_meeting_note",
  payload: {
    meetingId: "90a21496-abf2-43e2-a10f-94267228afd4",
    title: "Client <script>alert(1)</script>",
    startedAt: "2026-08-12T09:00:00.000Z",
    endedAt: null,
    source: "manual",
    sourceMeetingId: "meeting-1",
    sourceUrl: null,
    participants: [{ name: "Alex", email: "alex@example.com", external: false }],
    summary: "Discussed <img src=x onerror=alert(1)>",
    actionItems: [],
    decisions: [],
    includeTranscript: false
  },
  evidence: ["manual:meeting-1"], confidence: 0.8, status: "approved",
  idempotencyKey: "a".repeat(64), createdAt: "2026-08-12T09:01:00.000Z",
  reviewedAt: "2026-08-12T09:02:00.000Z", deliveredAt: null, lastError: null
};

describe("Obsidian destination", () => {
  it("recognises an unchanged note on retry and removes it idempotently", async () => {
    const root = await fixtureRoot();
    expect((await deliverObsidianProposal(proposal, root)).alreadyExisted).toBe(false);
    expect((await deliverObsidianProposal(proposal, root)).alreadyExisted).toBe(true);
    expect(await removeObsidianArtifact(proposal, root)).toBe(true);
    expect(await removeObsidianArtifact(proposal, root)).toBe(false);
  });

  it.each(["edited", "replaced", "truncated"])("preserves a %s note on retry and removal", async (kind) => {
    const root = await fixtureRoot();
    const rendered = renderObsidianMeeting(proposal);
    const target = join(root, rendered.filename);
    const content = kind === "edited" ? `${rendered.markdown}\nHuman notes\n`
      : kind === "truncated" ? rendered.markdown.slice(0, -30) : "An unrelated note";
    await writeFile(target, content, "utf8");
    await expect(deliverObsidianProposal(proposal, root)).rejects.toBeInstanceOf(ObsidianArtifactConflictError);
    await expect(removeObsidianArtifact(proposal, root)).rejects.toBeInstanceOf(ObsidianArtifactConflictError);
    expect(await readFile(target, "utf8")).toBe(content);
  });

  it("refuses directories at the target note path", async () => {
    const root = await fixtureRoot();
    const target = join(root, renderObsidianMeeting(proposal).filename);
    await mkdir(target);
    await expect(deliverObsidianProposal(proposal, root)).rejects.toBeInstanceOf(ObsidianArtifactConflictError);
    await expect(removeObsidianArtifact(proposal, root)).rejects.toBeInstanceOf(ObsidianArtifactConflictError);
    expect((await lstat(target)).isDirectory()).toBe(true);
  });

  it("refuses symbolic links even when their target has identical contents", async ({ skip }) => {
    const root = await fixtureRoot();
    const rendered = renderObsidianMeeting(proposal);
    const external = join(await fixtureRoot(), "external.md");
    await writeFile(external, rendered.markdown, "utf8");
    const target = join(root, rendered.filename);
    try {
      await symlink(external, target, "file");
    } catch (error) {
      if (process.platform === "win32" && (error as NodeJS.ErrnoException).code === "EPERM") {
        skip(); // Windows may require developer mode; CI runs this case on Linux.
        return;
      }
      throw error;
    }
    await expect(deliverObsidianProposal(proposal, root)).rejects.toBeInstanceOf(ObsidianArtifactConflictError);
    await expect(removeObsidianArtifact(proposal, root)).rejects.toBeInstanceOf(ObsidianArtifactConflictError);
    expect((await lstat(target)).isSymbolicLink()).toBe(true);
    expect(await readFile(external, "utf8")).toBe(rendered.markdown);
  });

  it("creates a deterministic safe filename and neutralizes raw HTML", () => {
    const rendered = renderObsidianMeeting(proposal);
    expect(rendered.filename).toBe("2026-08-12 - client-script-alert-1-script - 90a21496.md");
    expect(rendered.markdown).not.toContain("<script>");
    expect(rendered.markdown).toContain("&lt;script&gt;");
    expect(rendered.markdown).toContain("mutability: review-first");
  });
});
