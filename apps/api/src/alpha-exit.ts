import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { CanonicalMeeting, RoutingProposal } from "@meeting-context-router/core";
import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import { previewFathomExport } from "./dogfood.js";

// Alpha exit flow: one Fathom meeting becomes a pending proposal in the
// quarantined Obsidian inbox, an approval writes it through the router, and a
// replay of the same meeting creates no duplicate meeting, proposal or file.
// Everything is written under `<root>/data/quarantine/`. The CRM proposal is
// never approved or delivered, and the router state is a fresh file per run.

export type AlphaExitIntake =
  | { kind: "fixture"; payload: unknown }
  | { kind: "fathom-api"; meetingId: string; fathomApiKey: string; createdAfter: string; createdBefore: string };

export interface AlphaExitResult {
  sourceMeetingId: string;
  quarantineProposalPath: string;
  approvedNotePath: string;
  first: { status: number; duplicate: boolean; proposalIds: string[] };
  replay: { status: number; duplicate: boolean; proposalIds: string[]; previewRefused: boolean };
  counts: { meetings: number; proposals: number; quarantineFiles: number; approvedFiles: number };
  // Router totals straight after the first intake, so a caller can prove the
  // replay added nothing.
  countsAfterFirst: { meetings: number; proposals: number };
  // Final status of each proposal for this meeting, keyed by target.
  proposalStatuses: Record<string, string>;
}

const OPERATOR_TOKEN = randomBytes(24).toString("hex");
const auth = { authorization: `Bearer ${OPERATOR_TOKEN}` };

function signedFathomWebhook(secret: string, raw: string) {
  const id = `msg_${randomUUID()}`;
  const timestamp = String(Math.floor(Date.now() / 1_000));
  const signature = createHmac("sha256", Buffer.from(secret.slice("whsec_".length), "base64"))
    .update(`${id}.${timestamp}.${raw}`, "utf8")
    .digest("base64");
  return { "content-type": "application/json", "webhook-id": id, "webhook-timestamp": timestamp, "webhook-signature": `v1,${signature}` };
}

export async function runAlphaExit(intake: AlphaExitIntake, root: string, runId = new Date().toISOString().replace(/[:.]/g, "-")): Promise<AlphaExitResult> {
  const quarantine = resolve(root, "data/quarantine");
  const approvedRoot = resolve(quarantine, "obsidian-approved");
  const inbox = resolve(quarantine, "obsidian-inbox");
  await mkdir(approvedRoot, { recursive: true });
  // A local, per-run webhook secret: the fixture path exercises the router's
  // real signature check without any Fathom credential.
  const webhookSecret = `whsec_${randomBytes(32).toString("base64")}`;
  const config = loadConfig({
    NODE_ENV: "test",
    MEETING_ROUTER_STATE_PATH: resolve(quarantine, `alpha-exit-state-${runId}.json`),
    OBSIDIAN_OUTPUT_ROOT: approvedRoot,
    FATHOM_WEBHOOK_SECRET: webhookSecret,
    ...(intake.kind === "fathom-api" ? { FATHOM_API_KEY: intake.fathomApiKey } : {}),
    MEETING_ROUTER_PRINCIPALS: JSON.stringify([
      { id: "alpha-exit-operator", type: "human", token: OPERATOR_TOKEN, scopes: ["meeting:read", "proposal:read", "proposal:review", "proposal:deliver", "source:sync"] },
    ]),
  });
  const app = await buildApp(config);
  try {
    async function ingest() {
      if (intake.kind === "fixture") {
        const raw = JSON.stringify(intake.payload);
        const response = await app.inject({ method: "POST", url: "/v1/intake/fathom", headers: signedFathomWebhook(webhookSecret, raw), payload: raw });
        if (response.statusCode !== 202 && response.statusCode !== 200) throw new Error(`Fathom intake returned ${response.statusCode}`);
        const data = response.json().data as { meetingId: string; proposalIds: string[]; duplicate: boolean };
        return { status: response.statusCode, ...data };
      }
      const response = await app.inject({ method: "POST", url: "/v1/sources/fathom/sync", headers: auth, payload: { createdAfter: intake.createdAfter, createdBefore: intake.createdBefore, maxMeetings: 100 } });
      if (response.statusCode !== 202) throw new Error(`Fathom sync returned ${response.statusCode}`);
      const meeting = (await readState(config.statePath)).meetings.find((candidate) => candidate.provenance.sourceMeetingId === intake.meetingId);
      if (!meeting) throw new Error("The meeting id was not in the Fathom sync window");
      const proposals = (await app.inject({ method: "GET", url: "/v1/proposals", headers: auth })).json().data as RoutingProposal[];
      const sync = response.json().data as { created: number; duplicates: number };
      return { status: response.statusCode, meetingId: meeting.id, proposalIds: proposals.filter((proposal) => proposal.meetingId === meeting.id).map((proposal) => proposal.id), duplicate: sync.created === 0 && sync.duplicates > 0 };
    }

    const totals = async () => ({
      meetings: (await app.inject({ method: "GET", url: "/v1/meetings", headers: auth })).json().total as number,
      proposals: ((await app.inject({ method: "GET", url: "/v1/proposals", headers: auth })).json().data as RoutingProposal[]).length,
    });

    const first = await ingest();
    const countsAfterFirst = await totals();
    const proposals =(await app.inject({ method: "GET", url: "/v1/proposals", headers: auth })).json().data as RoutingProposal[];
    const obsidian = proposals.find((proposal) => proposal.target === "obsidian" && proposal.meetingId === first.meetingId);
    if (!obsidian || obsidian.status !== "pending") throw new Error("No pending Obsidian proposal after intake");
    const sourceMeetingId = (await readState(config.statePath)).meetings.find((meeting) => meeting.id === first.meetingId)!.provenance.sourceMeetingId;

    // 1. Pending proposal in the quarantined inbox for human review.
    const meetingExport = intake.kind === "fixture" ? intake.payload : await exportFromState(config.statePath, first.meetingId);
    const preview = await previewFathomExport(meetingExport, root);

    // 2. Approval, then delivery writes the note.
    const approve = await app.inject({ method: "POST", url: `/v1/proposals/${obsidian.id}/approve`, headers: auth });
    if (approve.statusCode !== 200) throw new Error(`Approve returned ${approve.statusCode}`);
    const deliver = await app.inject({ method: "POST", url: `/v1/proposals/${obsidian.id}/deliver`, headers: auth });
    if (deliver.statusCode !== 200) throw new Error(`Deliver returned ${deliver.statusCode}`);
    const approvedNotePath = resolve(approvedRoot, deliver.json().data.artifact as string);

    // 3. Replay the same meeting: no new meeting, proposal or file.
    const replay = await ingest();
    const previewRefused = await previewFathomExport(meetingExport, root).then(() => false, (error: NodeJS.ErrnoException) => error.code === "EEXIST");
    const final = await totals();
    const finalProposals = (await app.inject({ method: "GET", url: "/v1/proposals", headers: auth })).json().data as RoutingProposal[];
    const proposalStatuses = Object.fromEntries(finalProposals.filter((proposal) => proposal.meetingId === first.meetingId).map((proposal) => [proposal.target, proposal.status]));
    return {
      sourceMeetingId,
      quarantineProposalPath: preview.path,
      approvedNotePath,
      first: { status: first.status, duplicate: first.duplicate, proposalIds: first.proposalIds },
      replay: { status: replay.status, duplicate: replay.duplicate, proposalIds: replay.proposalIds, previewRefused },
      counts: { meetings: final.meetings, proposals: final.proposals, quarantineFiles: (await readdir(inbox)).length, approvedFiles: (await readdir(approvedRoot)).length },
      countsAfterFirst,
      proposalStatuses,
    };
  } finally {
    await app.close();
  }
}

// The API path has no raw export to preview, so rebuild the Fathom-shaped
// fields the preview needs from the router's own stored meeting.
async function readState(statePath: string) {
  return JSON.parse(await readFile(statePath, "utf8")) as { meetings: CanonicalMeeting[] };
}

async function exportFromState(statePath: string, meetingId: string) {
  const meeting = (await readState(statePath)).meetings.find((candidate) => candidate.id === meetingId)!;
  return {
    title: meeting.title,
    recording_id: meeting.provenance.sourceMeetingId,
    share_url: meeting.provenance.sourceUrl,
    created_at: meeting.createdAt,
    scheduled_start_time: meeting.startedAt,
    scheduled_end_time: meeting.endedAt,
    calendar_invitees: meeting.participants.map((person) => ({ name: person.name, email: person.email, is_external: person.external })),
    default_summary: { markdown_formatted: meeting.summary },
    action_items: meeting.actionItems.map((item) => ({ description: item.description, completed: item.completed, recording_timestamp: item.evidenceTimestamp, assignee: item.assigneeName ? { name: item.assigneeName, email: item.assigneeEmail } : null })),
  };
}

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [meetingId, createdAfter, createdBefore] = process.argv.slice(2);
  const fathomApiKey = process.env.FATHOM_API_KEY?.trim() ?? "";
  if (!meetingId || !createdAfter || !createdBefore || process.argv.length !== 5 || !fathomApiKey) {
    process.stderr.write("Usage: FATHOM_API_KEY=... pnpm alpha-exit:fathom <recording-id> <created-after ISO> <created-before ISO>\n");
    process.exitCode = 1;
  } else {
    try {
      const result = await runAlphaExit({ kind: "fathom-api", meetingId, fathomApiKey, createdAfter, createdBefore }, repositoryRoot);
      // Paths, ids and counts only: never echo meeting content.
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      const ok = !result.first.duplicate && result.replay.duplicate && result.replay.previewRefused && result.counts.approvedFiles >= 1;
      process.exitCode = ok ? 0 : 1;
    } catch (error) {
      process.stderr.write(`Alpha exit run failed: ${error instanceof Error ? error.message.slice(0, 200) : "unknown error"}\n`);
      process.exitCode = 1;
    }
  }
}
