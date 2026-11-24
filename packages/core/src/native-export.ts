import { mkdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

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

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
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
  if (await exists(rolloutPath)) {
    return { status: "exists", rolloutPath };
  }

  const items = convertConversationToCodexRollout(
    params.messages,
    params.cwd,
    params.sessionId,
  );
  await mkdir(join(rolloutPath, ".."), { recursive: true });
  await writeFile(
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
  const dir = getClaudeCodeProjectDir(params.cwd, params.homeDir);
  const sessionPath = join(dir, `${params.sessionId}.jsonl`);
  if (await exists(sessionPath)) {
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
  await mkdir(dir, { recursive: true });
  await writeFile(sessionPath, `${lines.join("\n")}\n`);
  return { status: "exported", sessionPath };
}
