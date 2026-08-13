import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { sha256, stableJson, type RoutingProposal } from "@meeting-context-router/core";
import { z } from "zod";

export class ObsidianArtifactConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ObsidianArtifactConflictError";
  }
}

const payloadSchema = z.object({
  meetingId: z.uuid(),
  title: z.string().trim().min(1).max(500),
  startedAt: z.iso.datetime(),
  endedAt: z.iso.datetime().nullable(),
  source: z.string().trim().min(1).max(50),
  sourceMeetingId: z.string().trim().min(1).max(500),
  sourceUrl: z.url().max(2_000).nullable(),
  participants: z.array(z.object({ name: z.string().max(200), email: z.email().nullable(), external: z.boolean().nullable() })).max(250),
  summary: z.string().max(50_000),
  actionItems: z.array(z.object({
    description: z.string().max(2_000),
    assigneeName: z.string().max(200).nullable(),
    assigneeEmail: z.email().nullable(),
    dueOn: z.iso.date().nullable(),
    completed: z.boolean(),
    evidenceTimestamp: z.string().max(32).nullable(),
  })).max(250),
  decisions: z.array(z.string().max(2_000)).max(250),
  includeTranscript: z.literal(false),
});

function safeText(value: string): string {
  return value.replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function slug(value: string): string {
  const result = value.normalize("NFKD").replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-|-$/g, "").toLowerCase().slice(0, 80);
  return result || "meeting";
}

export function renderObsidianMeeting(proposal: RoutingProposal): { filename: string; markdown: string; contentHash: string } {
  if (proposal.target !== "obsidian" || proposal.operation !== "write_meeting_note") throw new Error("Unsupported Obsidian proposal");
  const payload = payloadSchema.parse(proposal.payload);
  const date = payload.startedAt.slice(0, 10);
  const filename = `${date} - ${slug(payload.title)} - ${payload.meetingId.slice(0, 8)}.md`;
  const participantLines = payload.participants.length
    ? payload.participants.map((person) => `- ${safeText(person.name)}${person.email ? ` — ${safeText(person.email)}` : ""}`).join("\n")
    : "- None recorded";
  const decisionLines = payload.decisions.length ? payload.decisions.map((decision) => `- ${safeText(decision)}`).join("\n") : "- None extracted";
  const actionLines = payload.actionItems.length
    ? payload.actionItems.map((item) => `- [${item.completed ? "x" : " "}] ${safeText(item.description)}${item.assigneeName ? ` — ${safeText(item.assigneeName)}` : ""}`).join("\n")
    : "- None extracted";

  const contentHash = sha256(stableJson(proposal.payload));
  const markdown = `---\ntype: meeting-context\nmeeting_id: ${JSON.stringify(payload.meetingId)}\nsource: ${JSON.stringify(payload.source)}\nsource_meeting_id: ${JSON.stringify(payload.sourceMeetingId)}\nstarted_at: ${JSON.stringify(payload.startedAt)}\nrouter_proposal_id: ${JSON.stringify(proposal.id)}\nrouter_content_hash: ${JSON.stringify(contentHash)}\nmutability: review-first\n---\n\n# ${safeText(payload.title)}\n\n## Summary\n\n${safeText(payload.summary) || "No summary supplied."}\n\n## Participants\n\n${participantLines}\n\n## Decisions\n\n${decisionLines}\n\n## Action items\n\n${actionLines}\n\n## Provenance\n\n- Source: ${safeText(payload.source)}\n- Source meeting ID: ${safeText(payload.sourceMeetingId)}${payload.sourceUrl ? `\n- Source URL: ${payload.sourceUrl}` : ""}\n- Router proposal: ${proposal.id}\n`;
  return { filename, markdown, contentHash };
}

function embeddedFrontmatterValue(markdown: string, key: string): string | null {
  const match = markdown.match(new RegExp(`^${key}: (".*?")$`, "m"));
  if (!match) return null;
  try {
    return JSON.parse(match[1] as string) as string;
  } catch {
    return null;
  }
}

export async function deliverObsidianProposal(proposal: RoutingProposal, outputRoot: string): Promise<{ path: string; filename: string; contentHash: string; alreadyExisted: boolean }> {
  const { filename, markdown, contentHash } = renderObsidianMeeting(proposal);
  const root = resolve(outputRoot);
  const target = resolve(root, filename);
  const relation = relative(root, target);
  if (!relation || relation.startsWith("..") || isAbsolute(relation)) throw new Error("Resolved note path escaped the configured Obsidian root");
  await mkdir(root, { recursive: true });
  try {
    await writeFile(target, markdown, { encoding: "utf8", flag: "wx" });
    return { path: target, filename, contentHash, alreadyExisted: false };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    // A pre-existing file only counts as a prior successful delivery when it
    // embeds this proposal's id AND this payload's content hash. Anything else
    // is a conflict that requires human review, never silent success.
    const existing = await readFile(target, "utf8");
    const existingProposalId = embeddedFrontmatterValue(existing, "router_proposal_id");
    const existingContentHash = embeddedFrontmatterValue(existing, "router_content_hash");
    if (existingProposalId === proposal.id && existingContentHash === contentHash) {
      return { path: target, filename, contentHash, alreadyExisted: true };
    }
    throw new ObsidianArtifactConflictError(
      "A different artifact already exists at the target path; the existing file does not match this proposal's id and content hash",
    );
  }
}

/** Removes a delivered artifact during meeting deletion, with containment checks. */
export async function removeObsidianArtifact(outputRoot: string, filename: string): Promise<boolean> {
  const root = resolve(outputRoot);
  const target = resolve(root, filename);
  const relation = relative(root, target);
  if (!relation || relation.startsWith("..") || isAbsolute(relation)) throw new Error("Artifact path escaped the configured Obsidian root");
  try {
    await rm(target);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}
