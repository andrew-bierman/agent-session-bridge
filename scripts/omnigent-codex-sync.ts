#!/usr/bin/env bun
// Copy Codex rollouts created by Omnigent's private per-session CODEX_HOMEs into
// the native Codex home and index them so they show up in `codex resume`.
//
// Usage:
//   bun scripts/omnigent-codex-sync.ts --omnigent-data <dir> [--codex-home ~/.codex] [--apply] [--sub-agents-only]
//
// Omnigent keeps each Codex session's private CODEX_HOME at
// <data dir>/codex-native/<hash>/codex-home. The data dir is ~/.omnigent, or
// $OMNIGENT_DATA_DIR when set (this script honors both). Omnigent prunes an
// inactive bridge dir 7 days after its last activity, so run this at least
// weekly (it is idempotent) or the native copy is lost with the private home.
//
// Dry run by default. With --apply it backs up the target state_N.sqlite first.
// Runs straight from TypeScript source; requires bun and the sqlite3 CLI.
import { copyFile, mkdir, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { backfillCodexThreadIndex } from "../packages/core/src/runtime.js";
import {
  listOmnigentCodexSessions,
  omnigentDataDir,
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

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

const all = await listOmnigentCodexSessions(dataDir);
const found = subAgentsOnly ? all.filter((s) => s.kind === "sub_agent") : all;

if (apply) {
  const dbs = (await readdir(codexHome))
    .filter((f) => /^state_\d+\.sqlite$/.test(f))
    .sort();
  const newest = dbs.at(-1);
  if (newest) {
    const backup = join(codexHome, `${newest}.bak-${Date.now()}`);
    await copyFile(join(codexHome, newest), backup);
    console.log(`backed up ${newest} -> ${backup}`);
  }
}

let copied = 0;
let skipped = 0;
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
  if (await exists(dest)) {
    console.log(`skip (already present): ${session.threadId}`);
    skipped++;
    continue;
  }
  const label =
    session.kind === "sub_agent"
      ? ` [sub-agent ${session.subAgentName ?? "?"} of ${session.parentConversationId ?? "?"}]`
      : "";
  console.log(
    `${apply ? "sync" : "would sync"}: ${session.threadId}  ${session.cwd}${label}`,
  );
  if (!apply) continue;
  await mkdir(join(dest, ".."), { recursive: true });
  await copyFile(session.rolloutPath, dest);
  const result = await backfillCodexThreadIndex({
    homeDir: join(codexHome, ".."),
    threadId: session.threadId,
    rolloutPath: dest,
    cwd: session.cwd,
  });
  console.log(`  indexed: ${JSON.stringify(result)}`);
  copied++;
}
console.log(
  `${found.length} rollouts found, ${copied} synced, ${skipped} skipped${apply ? "" : " (dry run)"}`,
);
