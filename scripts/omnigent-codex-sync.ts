#!/usr/bin/env bun
// Copy Codex rollouts created by Omnigent's private per-session CODEX_HOMEs into
// the native Codex home and index them so they show up in `codex resume`.
//
// Usage:
//   bun scripts/omnigent-codex-sync.ts --omnigent-data <dir> [--codex-home ~/.codex] [--apply] [--sub-agents-only] [--model-provider openai]
//
// Omnigent keeps each Codex session's private CODEX_HOME at
// <data dir>/codex-native/<hash>/codex-home. The data dir is ~/.omnigent, or
// $OMNIGENT_DATA_DIR when set (this script honors both). Omnigent prunes an
// inactive bridge dir 7 days after its last activity, so run this at least
// weekly (it is idempotent) or the native copy is lost with the private home.
//
// Omnigent bridges Codex through its own `omnigent_provider`, which plain Codex
// cannot resume; the copy is retargeted to --model-provider (default openai).
// Dry run by default. With --apply it backs up the target state_N.sqlite first.
// Runs straight from TypeScript source; requires bun and the sqlite3 CLI.
import { mkdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { backfillCodexThreadIndex } from "../packages/core/src/runtime.js";
import {
  backupNewestCodexState,
  pathExists,
  writeFileAtomic,
} from "../packages/core/src/native-export.js";
import {
  listOmnigentCodexSessions,
  omnigentDataDir,
  retargetOmnigentProvider,
} from "../packages/core/src/omnigent.js";

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(name);
const opt = (name: string, fallback: string) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};

const dataDir = resolve(opt("--omnigent-data", omnigentDataDir()));
const codexHome = resolve(opt("--codex-home", join(homedir(), ".codex")));
const apply = flag("--apply");
const subAgentsOnly = flag("--sub-agents-only");
const modelProvider = opt("--model-provider", "openai");

const all = await listOmnigentCodexSessions(dataDir);
const found = subAgentsOnly ? all.filter((s) => s.kind === "sub_agent") : all;

if (apply) {
  const result = await backupNewestCodexState(codexHome);
  if (result) console.log(`backed up ${result.name} -> ${result.backup}`);
}

let copied = 0;
let existing = 0;
let failed = 0;
for (const session of found) {
  const d = new Date(session.startedAt);
  const dest = join(
    codexHome,
    "sessions",
    String(d.getUTCFullYear()),
    String(d.getUTCMonth() + 1).padStart(2, "0"),
    String(d.getUTCDate()).padStart(2, "0"),
    basename(session.rolloutPath),
  );
  const label =
    session.kind === "sub_agent"
      ? ` [sub-agent ${session.subAgentName ?? "?"} of ${session.parentConversationId ?? "?"}]`
      : "";
  console.log(
    `${apply ? "sync" : "would sync"}: ${session.threadId}  ${session.cwd}${label}`,
  );
  if (!apply) continue;
  await mkdir(join(dest, ".."), { recursive: true });
  // Omnigent runs bridged Codex through its own provider, which plain Codex does
  // not have configured and so refuses to resume. Copy with that provider
  // retargeted; the source rollout is left untouched. An existing destination
  // is left as is but still re-indexed, so a copy whose index step failed
  // earlier is repaired by simply running again.
  if (await pathExists(dest)) {
    existing++;
  } else {
    await writeFileAtomic(
      dest,
      retargetOmnigentProvider(
        await readFile(session.rolloutPath, "utf8"),
        modelProvider,
      ),
    );
    copied++;
  }
  try {
    const result = await backfillCodexThreadIndex({
      homeDir: join(codexHome, ".."),
      threadId: session.threadId,
      rolloutPath: dest,
      cwd: session.cwd,
    });
    console.log(`  indexed: ${JSON.stringify(result)}`);
    if (!result.indexed) failed++;
  } catch (error) {
    console.error(`  not indexed: ${session.threadId}: ${String(error)}`);
    failed++;
  }
}
console.log(
  `${found.length} rollouts found, ${copied} synced, ${existing} already present, ${failed} not indexed${apply ? "" : " (dry run)"}`,
);
if (failed > 0) process.exit(1);
