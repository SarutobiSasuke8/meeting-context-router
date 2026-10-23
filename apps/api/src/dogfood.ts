import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { type RoutingProposal, createRoutingProposals } from "@meeting-context-router/core";
import { renderObsidianMeeting } from "@meeting-context-router/destination-obsidian";
import { normalizeFathomMeeting } from "@meeting-context-router/source-fathom";

// This is a local preview exporter. It deliberately never loads runtime config,
// the router store, a vendor client or either destination delivery function.
export async function previewFathomExport(input: unknown, repositoryRoot: string) {
  const meeting = normalizeFathomMeeting(input, { transport: "manual", signatureVerified: false });
  const proposal = createRoutingProposals(meeting).find((item) => item.target === "obsidian")!;
  return previewRoutingProposal(proposal, repositoryRoot, meeting.provenance.sourceHash);
}

/** Preview the actual pending router proposal, preserving its identity. */
export async function previewRoutingProposal(proposal: RoutingProposal, repositoryRoot: string, sourceHash: string, transport = "manual") {
  const preview = renderObsidianMeeting(proposal);
  const provenance = transport === "manual"
    ? "Offline preview only. Nothing has been approved, delivered or added to router state.\nThe source was imported manually; its webhook signature has not been verified."
    : `Router proposal preview from Fathom ${transport} intake. No destination delivery has occurred at preview time.`;
  const markdown = `---\ntype: quarantined-routing-proposal\nstatus: pending\nmutability: review-first\ndry_run: true\nsource: fathom\nsource_meeting_id: ${JSON.stringify(proposal.payload.sourceMeetingId)}\nsource_sha256: ${JSON.stringify(sourceHash)}\nproposal_id: ${JSON.stringify(proposal.id)}\nproposal_status: ${proposal.status}\n---\n\n# Quarantined proposal: review required\n\n${provenance}\nDo not move this file into a system of record as an approved meeting note.\n\n## Proposed Obsidian note (untrusted source content)\n\n${preview.markdown}`;
  const inbox = resolve(repositoryRoot, "data/quarantine/obsidian-inbox");
  const path = resolve(inbox, `fathom-${sourceHash}.proposal.md`);
  await mkdir(inbox, { recursive: true });
  await writeFile(path, markdown, { encoding: "utf8", flag: "wx" });
  return { path, proposal, sourceHash };
}

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const inputPath = process.argv[2];
  if (!inputPath || process.argv.length !== 3) {
    process.stderr.write("Usage: pnpm dogfood:fathom <one-fathom-export.json>\n");
    process.exitCode = 1;
  } else {
    try {
      const input: unknown = JSON.parse(await readFile(inputPath, "utf8"));
      const result = await previewFathomExport(input, repositoryRoot);
      process.stdout.write(`Pending quarantine proposal: ${result.path}\n`);
    } catch {
      // Schema errors can contain meeting text. Do not echo their details.
      process.stderr.write("Preview failed: check the export format, file permissions and whether this source already has a quarantine note. Existing files are preserved.\n");
      process.exitCode = 1;
    }
  }
}
