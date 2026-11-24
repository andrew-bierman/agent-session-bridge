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
import { copyFile, mkdir, readdir, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { convertNormalizedToClaudeLine } from "../packages/core/src/converters.js";
import {
  listOmnigentConversations,
  normalizeOmnigentConversationId,
  omnigentCodexThreadId,
  readOmnigentConversationMessages,
} from "../packages/core/src/omnigent-chat.js";
import { omnigentDataDir } from "../packages/core/src/omnigent.js";
import { getClaudeCodeProjectDir } from "../packages/core/src/path-utils.js";
import { backfillCodexThreadIndex } from "../packages/core/src/runtime.js";
import { convertConversationToCodexRollout } from "../packages/core/src/sync.js";

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(name);
const opt = (name: string): string | undefined => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const optAll = (name: string): string[] =>
  args.flatMap((a, i) => (a === name && args[i + 1] ? [args[i + 1]!] : []));

const dataDir = resolve(opt("--omnigent-data") ?? omnigentDataDir());
const target = opt("--target");
const apply = flag("--apply");
const cwdOverride = opt("--cwd");
const codexHome = resolve(opt("--codex-home") ?? join(homedir(), ".codex"));
const claudeHome = resolve(opt("--claude-home") ?? homedir());

if (target !== "codex" && target !== "claude") {
  console.error("--target codex|claude is required");
  process.exit(2);
}

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
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

let backedUp = false;
async function backupCodexState(): Promise<void> {
  if (backedUp || !apply || target !== "codex") return;
  backedUp = true;
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

let written = 0;
let skipped = 0;
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
  const started = new Date(messages[0]!.timestamp);

  if (target === "codex") {
    const stamp = started.toISOString().slice(0, 19).replaceAll(":", "-");
    const dir = join(
      codexHome,
      "sessions",
      String(started.getUTCFullYear()),
      String(started.getUTCMonth() + 1).padStart(2, "0"),
      String(started.getUTCDate()).padStart(2, "0"),
    );
    const dest = join(dir, `rollout-${stamp}-${sessionId}.jsonl`);
    if (await exists(dest)) {
      console.log(`skip (already present): ${label}`);
      skipped++;
      continue;
    }
    console.log(
      `${apply ? "export" : "would export"} -> codex ${sessionId}  ${cwd}  ${label}`,
    );
    if (!apply) continue;
    await backupCodexState();
    const items = convertConversationToCodexRollout(messages, cwd, sessionId);
    await mkdir(dir, { recursive: true });
    await writeFile(
      dest,
      `${items.map((item) => JSON.stringify({ timestamp: messages[0]!.timestamp, ...item })).join("\n")}\n`,
    );
    const result = await backfillCodexThreadIndex({
      homeDir: join(codexHome, ".."),
      threadId: sessionId,
      rolloutPath: dest,
      cwd,
    });
    console.log(`  indexed: ${JSON.stringify(result)}`);
  } else {
    const dir = getClaudeCodeProjectDir(cwd, claudeHome);
    const dest = join(dir, `${sessionId}.jsonl`);
    if (await exists(dest)) {
      console.log(`skip (already present): ${label}`);
      skipped++;
      continue;
    }
    console.log(
      `${apply ? "export" : "would export"} -> claude ${sessionId}  ${cwd}  ${label}`,
    );
    if (!apply) continue;
    let parent: string | null = null;
    const lines = messages.map((message) => {
      const line = convertNormalizedToClaudeLine(
        message,
        sessionId,
        parent,
        cwd,
      );
      parent = line.uuid ?? null;
      return JSON.stringify(line);
    });
    await mkdir(dir, { recursive: true });
    await writeFile(dest, `${lines.join("\n")}\n`);
  }
  written++;
}
console.log(
  `${selected.length} conversations, ${written} exported, ${skipped} skipped${apply ? "" : " (dry run)"}`,
);
