import {
  copyFile,
  mkdir,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";

import { convertNormalizedToClaudeLine } from "./converters.js";
import { getClaudeCodeProjectDir } from "./path-utils.js";
import { backfillCodexThreadIndex } from "./runtime.js";
import { convertConversationToCodexRollout } from "./sync.js";
import type { NormalizedMessage } from "./types.js";

export type ExportStatus = "exported" | "exists";

export interface CodexExportResult {
  status: ExportStatus;
  rolloutPath: string;
  /** Result of indexing in Codex's thread database; absent when skipped. */
  indexed?: { indexed: boolean; reason?: string };
}

export interface CodexExportParams {
  messages: NormalizedMessage[];
  cwd: string;
  /** Codex-shaped thread id (see `omnigentCodexThreadId`). */
  sessionId: string;
  /** Codex's data directory, normally `<home>/.codex`. */
  codexHome: string;
  /** Home directory that contains `.codex`, used to find the thread index. */
  homeDir: string;
}

/** Where an exported rollout lands: sessions/YYYY/MM/DD (UTC) by first message. */
export function codexRolloutPath(
  codexHome: string,
  sessionId: string,
  startedAt: string,
): string {
  const started = new Date(startedAt);
  const stamp = started.toISOString().slice(0, 19).replaceAll(":", "-");
  return join(
    codexHome,
    "sessions",
    String(started.getUTCFullYear()),
    String(started.getUTCMonth() + 1).padStart(2, "0"),
    String(started.getUTCDate()).padStart(2, "0"),
    `rollout-${stamp}-${sessionId}.jsonl`,
  );
}

/**
 * Write a file so a crash or a full disk never leaves a truncated copy under
 * its final name: write beside it, then rename into place. A truncated file
 * under the final name would be treated as already exported forever.
 */
export async function writeFileAtomic(
  path: string,
  text: string,
): Promise<void> {
  const temp = `${path}.tmp-${process.pid}-${Date.now()}`;
  try {
    await writeFile(temp, text);
    await rename(temp, path);
  } catch (error) {
    await rm(temp, { force: true });
    throw error;
  }
}

export async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Copy the newest `state_N.sqlite` in a Codex home to `<name>.bak-<timestamp>`
 * before the thread index is touched. Returns the backup's name and path, or
 * undefined when the home has no state database yet.
 */
export async function backupNewestCodexState(
  codexHome: string,
): Promise<{ name: string; backup: string } | undefined> {
  // Numeric, not lexical: state_10 is newer than state_5.
  const generation = (file: string) =>
    Number(/^state_(\d+)\.sqlite$/.exec(file)![1]);
  const newest = (await readdir(codexHome))
    .filter((file) => /^state_\d+\.sqlite$/.test(file))
    .sort((a, b) => generation(a) - generation(b))
    .at(-1);
  if (!newest) return undefined;
  const stamp = Date.now();
  const backup = join(codexHome, `${newest}.bak-${stamp}`);
  await copyFile(join(codexHome, newest), backup);
  // A live Codex keeps recent writes in the WAL; a backup without it can lose them.
  for (const suffix of ["-wal", "-shm"]) {
    if (await pathExists(join(codexHome, `${newest}${suffix}`))) {
      await copyFile(
        join(codexHome, `${newest}${suffix}`),
        `${backup}${suffix}`,
      );
    }
  }
  return { name: newest, backup };
}

/** Where an exported Claude Code session lands for a working directory. */
export function claudeSessionPath(
  cwd: string,
  homeDir: string,
  sessionId: string,
): string {
  return join(getClaudeCodeProjectDir(cwd, homeDir), `${sessionId}.jsonl`);
}

/**
 * Write normalized messages as a native Codex rollout and index it so it shows
 * up in `codex resume`. Never overwrites an existing rollout: re-running is a
 * no-op that reports `exists`.
 */
export async function exportCodexSession(
  params: CodexExportParams,
): Promise<CodexExportResult> {
  const first = params.messages[0];
  if (!first) {
    throw new Error("Cannot export a conversation with no messages");
  }
  const rolloutPath = codexRolloutPath(
    params.codexHome,
    params.sessionId,
    first.timestamp,
  );
  if (await pathExists(rolloutPath)) {
    // An earlier run may have written the rollout but not indexed it (Codex had
    // no thread database yet, or the run was interrupted). Indexing is an
    // idempotent upsert, so make sure it is done.
    const indexed = await backfillCodexThreadIndex({
      homeDir: params.homeDir,
      threadId: params.sessionId,
      rolloutPath,
      cwd: params.cwd,
    });
    return { status: "exists", rolloutPath, indexed };
  }

  const items = convertConversationToCodexRollout(
    params.messages,
    params.cwd,
    params.sessionId,
  );
  await mkdir(join(rolloutPath, ".."), { recursive: true });
  await writeFileAtomic(
    rolloutPath,
    `${items
      .map((item) => JSON.stringify({ timestamp: first.timestamp, ...item }))
      .join("\n")}\n`,
  );
  const indexed = await backfillCodexThreadIndex({
    homeDir: params.homeDir,
    threadId: params.sessionId,
    rolloutPath,
    cwd: params.cwd,
  });
  return { status: "exported", rolloutPath, indexed };
}

export interface ClaudeExportParams {
  messages: NormalizedMessage[];
  cwd: string;
  sessionId: string;
  /** Home directory that contains `.claude`. */
  homeDir: string;
}

export interface ClaudeExportResult {
  status: ExportStatus;
  sessionPath: string;
}

/** Write normalized messages as a native Claude Code session. Never overwrites. */
export async function exportClaudeSession(
  params: ClaudeExportParams,
): Promise<ClaudeExportResult> {
  if (params.messages.length === 0) {
    throw new Error("Cannot export a conversation with no messages");
  }
  const sessionPath = claudeSessionPath(
    params.cwd,
    params.homeDir,
    params.sessionId,
  );
  if (await pathExists(sessionPath)) {
    return { status: "exists", sessionPath };
  }
  let parent: string | null = null;
  const lines = params.messages.map((message) => {
    const line = convertNormalizedToClaudeLine(
      message,
      params.sessionId,
      parent,
      params.cwd,
    );
    parent = line.uuid ?? null;
    return JSON.stringify(line);
  });
  await mkdir(dirname(sessionPath), { recursive: true });
  await writeFileAtomic(sessionPath, `${lines.join("\n")}\n`);
  return { status: "exported", sessionPath };
}
