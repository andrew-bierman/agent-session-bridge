#!/usr/bin/env bun
// Export Omnigent conversations (from chat.db) as native Codex or Claude Code
// sessions. This is the path for spec-defined sub-agents, which have no native
// bridge: their history exists only in <data dir>/chat.db.
//
// Usage:
//   bun scripts/omnigent-chat-export.ts --omnigent-data <dir> --target codex|claude
//     [--conversation <id> ...] [--sub-agents-only] [--cwd <dir>]
//     [--codex-home ~/.codex] [--claude-home ~] [--apply]
//
// Dry run by default. chat.db is only ever opened read-only. Exports are
// idempotent: the native session id derives from the conversation id and an
// existing file is never overwritten. With --apply and --target codex the
// newest state_N.sqlite is backed up before the thread index is touched.
// Requires bun and the sqlite3 CLI.
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import {
  listOmnigentConversations,
  normalizeOmnigentConversationId,
  omnigentCodexThreadId,
  readOmnigentConversationMessages,
} from "../packages/core/src/omnigent-chat.js";
import {
  backupNewestCodexState,
  claudeSessionPath,
  codexRolloutPath,
  exportClaudeSession,
  exportCodexSession,
  pathExists,
} from "../packages/core/src/native-export.js";
import { omnigentDataDir } from "../packages/core/src/omnigent.js";

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(name);
// A flag with no value (or another flag in its place) is a usage error: a
// silently ignored --conversation would select every conversation.
const valueAt = (i: number, name: string): string => {
  const v = args[i + 1];
  if (v === undefined || v === "" || v.startsWith("--")) {
    console.error(`${name} needs a value`);
    process.exit(2);
  }
  return v;
};
const opt = (name: string): string | undefined => {
  const i = args.indexOf(name);
  return i >= 0 ? valueAt(i, name) : undefined;
};
const optAll = (name: string): string[] =>
  args.flatMap((a, i) => (a === name ? [valueAt(i, name)] : []));

const dataDir = resolve(opt("--omnigent-data") ?? omnigentDataDir());
const target = opt("--target");
const apply = flag("--apply");
const cwdOverride = opt("--cwd");
const codexHome = resolve(opt("--codex-home") ?? join(homedir(), ".codex"));
const claudeHome = resolve(opt("--claude-home") ?? homedir());
const codexParent = join(codexHome, "..");

if (target !== "codex" && target !== "claude") {
  console.error("--target codex|claude is required");
  process.exit(2);
}

const wanted = new Set(
  optAll("--conversation").map(normalizeOmnigentConversationId),
);
const all = await listOmnigentConversations(dataDir);
const selected = all.filter((c) => {
  if (wanted.size > 0) return wanted.has(c.id);
  if (flag("--sub-agents-only")) return c.kind === "sub_agent";
  return true;
});

const unknown = [...wanted].filter((id) => !all.some((c) => c.id === id));
if (unknown.length > 0) {
  console.error(`conversation not found in chat.db: ${unknown.join(", ")}`);
  process.exit(1);
}

let backedUp = false;
async function backupCodexState(): Promise<void> {
  if (backedUp || !apply || target !== "codex") return;
  backedUp = true;
  const result = await backupNewestCodexState(codexHome);
  if (result) console.log(`backed up ${result.name} -> ${result.backup}`);
}

let written = 0;
let skipped = 0;
let failed = 0;
for (const conv of selected) {
  const messages = await readOmnigentConversationMessages(dataDir, conv.id);
  const label = `${conv.id}${conv.kind === "sub_agent" ? ` [sub-agent ${conv.subAgentName ?? "?"} of ${conv.parentId ?? "?"}]` : ""}`;
  if (messages.length === 0) {
    console.log(`skip (no messages): ${label}`);
    skipped++;
    continue;
  }
  const cwd = cwdOverride ?? conv.workspace ?? process.cwd();
  const sessionId = omnigentCodexThreadId(conv.id);

  if (target === "codex") {
    const dest = codexRolloutPath(codexHome, sessionId, messages[0]!.timestamp);
    if (await pathExists(dest)) {
      console.log(`skip (already present): ${label}`);
      skipped++;
      continue;
    }
    console.log(
      `${apply ? "export" : "would export"} -> codex ${sessionId}  ${cwd}  ${label}`,
    );
    if (!apply) continue;
    await backupCodexState();
    const result = await exportCodexSession({
      messages,
      cwd,
      sessionId,
      codexHome,
      homeDir: codexParent,
    });
    console.log(`  indexed: ${JSON.stringify(result.indexed)}`);
    if (!result.indexed?.indexed) failed++;
  } else {
    const dest = claudeSessionPath(cwd, claudeHome, sessionId);
    if (await pathExists(dest)) {
      console.log(`skip (already present): ${label}`);
      skipped++;
      continue;
    }
    console.log(
      `${apply ? "export" : "would export"} -> claude ${sessionId}  ${cwd}  ${label}`,
    );
    if (!apply) continue;
    await exportClaudeSession({
      messages,
      cwd,
      sessionId,
      homeDir: claudeHome,
    });
  }
  written++;
}
console.log(
  `${selected.length} conversations, ${written} exported, ${skipped} skipped${apply ? "" : " (dry run)"}`,
);
if (failed > 0) {
  console.error(
    `${failed} rollout(s) written but not indexed; re-run to retry`,
  );
  process.exit(1);
}
