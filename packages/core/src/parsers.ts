import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { readFile } from "node:fs/promises";
import { createZstdDecompress } from "node:zlib";

import type {
  ClaudeCodeLine,
  CodexRolloutItem,
  PiSession,
  PiSessionEntry,
  PiSessionHeader,
} from "./types.js";

function parseJsonLines(content: string): unknown[] {
  return content
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

export async function readPiSession(path: string): Promise<PiSession> {
  const content = await readFile(path, "utf8");
  const lines = parseJsonLines(content);
  const [header, ...entries] = lines as [PiSessionHeader, ...PiSessionEntry[]];

  if (!header || header.type !== "session") {
    throw new Error("Invalid Pi session");
  }

  return {
    header,
    entries,
  };
}

export async function readClaudeCodeSession(
  path: string,
): Promise<ClaudeCodeLine[]> {
  const content = await readFile(path, "utf8");
  return parseJsonLines(content) as ClaudeCodeLine[];
}

export async function readCodexRollout(
  path: string,
): Promise<CodexRolloutItem[]> {
  const items: CodexRolloutItem[] = [];
  for await (const item of iterateCodexRollout(path)) items.push(item);
  return items;
}

export async function* iterateCodexRollout(
  path: string,
): AsyncGenerator<CodexRolloutItem> {
  const file = createReadStream(path);
  const input = path.endsWith(".zst")
    ? file.compose(createZstdDecompress())
    : file;
  const lines = createInterface({ input, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      if (line.trim()) yield JSON.parse(line) as CodexRolloutItem;
    }
  } finally {
    lines.close();
    input.destroy();
    file.destroy();
  }
}

export function flattenPiActiveBranch(session: PiSession): PiSessionEntry[] {
  const byId = new Map<string, PiSessionEntry>();
  let latest: PiSessionEntry | undefined;

  for (const entry of session.entries) {
    if (entry.id) {
      byId.set(entry.id, entry);
      latest = entry;
    }
  }

  if (!latest?.id) {
    return session.entries;
  }

  const branch: PiSessionEntry[] = [];
  let current: PiSessionEntry | undefined = latest;

  while (current) {
    branch.push(current);
    current = current.parentId ? byId.get(current.parentId) : undefined;
  }

  return branch.reverse();
}

export function extractMessageEntries(
  entries: PiSessionEntry[],
): PiSessionEntry[] {
  return entries.filter(
    (entry) => entry.type === "message" && typeof entry.message === "object",
  );
}
