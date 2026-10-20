#!/usr/bin/env node
// Pick one real Fathom meeting for the Week 43 dogfood run and export it as a
// single JSON file for `pnpm dogfood:fathom`.
//
//   FATHOM_API_KEY=... node scripts/fathom-pick.mjs list
//   FATHOM_API_KEY=... node scripts/fathom-pick.mjs export <recording_id> <outfile.json>
//
// `list` prints recording id, date, title and invitee count, never summaries or
// transcripts. `export` writes the full meeting object to a file OUTSIDE this
// repository (private exports must stay out of Git) and refuses to overwrite.
// The key is read from the environment only and is never printed or stored.
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const apiKey = process.env.FATHOM_API_KEY;
const [command, recordingId, outFile] = process.argv.slice(2);
if (!apiKey || !["list", "export"].includes(command ?? "") || (command === "export" && (!recordingId || !outFile))) {
  console.error("usage: FATHOM_API_KEY=... node scripts/fathom-pick.mjs list");
  console.error("       FATHOM_API_KEY=... node scripts/fathom-pick.mjs export <recording_id> <outfile.json>");
  process.exit(2);
}

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

async function page(cursor, full) {
  const url = new URL("https://api.fathom.ai/external/v1/meetings");
  if (full) {
    url.searchParams.set("include_action_items", "true");
    url.searchParams.set("include_summary", "true");
    url.searchParams.set("include_transcript", "true");
  }
  if (cursor) url.searchParams.set("cursor", cursor);
  const response = await fetch(url, {
    headers: { "X-Api-Key": apiKey, Accept: "application/json" },
    redirect: "error",
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`Fathom API request failed with status ${response.status}`);
  return response.json();
}

try {
  if (command === "list") {
    const data = await page(null, false);
    for (const item of (data.items ?? []).slice(0, 25)) {
      const invitees = Array.isArray(item.calendar_invitees) ? item.calendar_invitees.length : 0;
      console.log(`${item.recording_id}\t${String(item.created_at ?? "").slice(0, 16)}\t${invitees} invitees\t${item.title ?? "(untitled)"}`);
    }
    console.log("\nPick one with no sensitive third-party content, then run the export command.");
  } else {
    const target = resolve(outFile);
    if (!relative(repoRoot, target).startsWith("..")) {
      throw new Error("Refusing to write inside the repository. Use a folder outside it, for example your Documents folder.");
    }
    if (existsSync(target)) throw new Error("Refusing to overwrite an existing file.");
    let cursor = null;
    let found = null;
    for (let i = 0; i < 10 && !found; i += 1) {
      const data = await page(cursor, true);
      found = (data.items ?? []).find((item) => String(item.recording_id) === recordingId) ?? null;
      cursor = data.next_cursor;
      if (!cursor) break;
    }
    if (!found) throw new Error("Recording id not found in the first 10 pages of meetings.");
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, `${JSON.stringify(found, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    console.log(`Wrote ${target}. Next: pnpm dogfood:fathom "${target}"`);
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : "Request failed");
  process.exit(1);
}
