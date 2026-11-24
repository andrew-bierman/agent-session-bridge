import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * Omnigent runs native harnesses (Codex, OpenCode, ...) against private
 * per-session homes under its data dir instead of the tool's own home. These
 * helpers locate those sessions so existing providers can import them. They do
 * not add a new session format.
 *
 * Layout (verified against Omnigent 0.23.0):
 *   <data dir>/codex-native/<hash>/codex-home/sessions/YYYY/MM/DD/rollout-*.jsonl
 *   <hash> = sha256(conversation id as lowercase 32-hex)[:32]
 * Every sub-agent is its own conversation (`kind = 2`) with its own bridge dir,
 * so sub-agent sessions are found like any other and linked to their parent via
 * `chat.db`. Omnigent prunes an inactive bridge dir after 7 days.
 */
export interface OmnigentSession {
  tool: "codex";
  bridgeHash: string;
  rolloutPath: string;
  threadId: string;
  cwd: string;
  /** Session start from the rollout metadata (falls back to updatedAt). */
  startedAt: string;
  updatedAt: string;
  /** Present when chat.db is readable and holds the conversation. */
  conversationId?: string;
  parentConversationId?: string;
  rootConversationId?: string;
  kind?: "default" | "sub_agent";
  subAgentName?: string;
  title?: string;
}

export function omnigentDataDir(
  env: Record<string, string | undefined> = process.env,
  homeDir: string = homedir(),
): string {
  return env.OMNIGENT_DATA_DIR
    ? env.OMNIGENT_DATA_DIR
    : join(homeDir, ".omnigent");
}

export function omnigentBridgeHash(conversationId: string): string {
  return createHash("sha256")
    .update(conversationId.replaceAll("-", "").toLowerCase())
    .digest("hex")
    .slice(0, 32);
}

interface ConversationRow {
  id: string;
  parent: string | null;
  root: string | null;
  title: string | null;
  kind: number | null;
  sub_agent_name: string | null;
}

async function readConversations(
  dataDir: string,
): Promise<Map<string, ConversationRow>> {
  const byHash = new Map<string, ConversationRow>();
  const dbPath = join(dataDir, "chat.db");
  try {
    await stat(dbPath);
    const { stdout } = await execFileAsync("sqlite3", [
      "-readonly",
      "-json",
      dbPath,
      `SELECT lower(hex(c.id)) AS id,
              lower(hex(c.parent_conversation_id)) AS parent,
              lower(hex(c.root_conversation_id)) AS root,
              c.title AS title,
              m.kind AS kind,
              m.sub_agent_name AS sub_agent_name
         FROM conversations c
         LEFT JOIN omnigent_conversation_metadata m
           ON m.id = c.id AND m.workspace_id = c.workspace_id;`,
    ]);
    const rows = stdout.trim() ? (JSON.parse(stdout) as ConversationRow[]) : [];
    for (const row of rows) {
      byHash.set(omnigentBridgeHash(row.id), row);
    }
  } catch {
    // chat.db missing, locked, or sqlite3 unavailable: sessions stay unlinked.
  }
  return byHash;
}

async function* walk(dir: string): AsyncGenerator<string> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walk(path);
    } else {
      yield path;
    }
  }
}

async function readSessionMeta(
  rolloutPath: string,
): Promise<{ id: string; cwd: string; timestamp?: string } | null> {
  const text = await readFile(rolloutPath, "utf8");
  for (const line of text.split("\n").slice(0, 50)) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line) as {
        type?: string;
        payload?: { id?: string; cwd?: string; timestamp?: string };
      };
      if (entry.type === "session_meta" && entry.payload?.id) {
        return {
          id: entry.payload.id,
          cwd: entry.payload.cwd ?? "",
          timestamp: entry.payload.timestamp,
        };
      }
    } catch {
      // ignore malformed line
    }
  }
  return null;
}

export async function listOmnigentCodexSessions(
  dataDir: string,
): Promise<OmnigentSession[]> {
  const root = join(dataDir, "codex-native");
  let bridges;
  try {
    bridges = await readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const conversations = await readConversations(dataDir);
  const sessions: OmnigentSession[] = [];

  for (const bridge of bridges) {
    if (!bridge.isDirectory()) continue;
    const sessionsDir = join(root, bridge.name, "codex-home", "sessions");
    for await (const path of walk(sessionsDir)) {
      if (!/^rollout-.*\.jsonl$/.test(basename(path))) continue;
      const meta = await readSessionMeta(path);
      if (!meta) continue;
      const updatedAt = (await stat(path)).mtime.toISOString();
      const row = conversations.get(bridge.name);
      sessions.push({
        tool: "codex",
        bridgeHash: bridge.name,
        rolloutPath: path,
        threadId: meta.id,
        cwd: meta.cwd,
        startedAt: meta.timestamp ?? updatedAt,
        updatedAt,
        conversationId: row?.id,
        parentConversationId: row?.parent || undefined,
        rootConversationId: row?.root || undefined,
        kind: row ? (row.kind === 2 ? "sub_agent" : "default") : undefined,
        subAgentName: row?.sub_agent_name || undefined,
        title: row?.title || undefined,
      });
    }
  }

  return sessions.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

/**
 * Provider id Omnigent gives a Codex session it bridges. Plain Codex has no such
 * provider configured, so a rollout that still names it cannot be resumed
 * outside Omnigent ("model provider ... is no longer configured").
 */
export const OMNIGENT_PROVIDER_ID = "omnigent_provider";

/**
 * Point a bridged rollout at a provider the target Codex has configured. Only
 * the two fields that record the provider change (`session_meta` and the
 * `thread_settings` event); every other line is returned byte for byte, and a
 * rollout from any other provider is returned unchanged.
 */
export function retargetOmnigentProvider(
  rolloutText: string,
  provider: string,
): string {
  return rolloutText
    .split("\n")
    .map((line) => {
      if (!line.includes(OMNIGENT_PROVIDER_ID)) return line;
      let entry: {
        type?: string;
        payload?: {
          model_provider?: string;
          thread_settings?: { model_provider_id?: string };
        };
      };
      try {
        entry = JSON.parse(line);
      } catch {
        return line;
      }
      const payload = entry.payload;
      if (!payload) return line;
      let changed = false;
      if (
        entry.type === "session_meta" &&
        payload.model_provider === OMNIGENT_PROVIDER_ID
      ) {
        payload.model_provider = provider;
        changed = true;
      }
      if (payload.thread_settings?.model_provider_id === OMNIGENT_PROVIDER_ID) {
        payload.thread_settings.model_provider_id = provider;
        changed = true;
      }
      return changed ? JSON.stringify(entry) : line;
    })
    .join("\n");
}
