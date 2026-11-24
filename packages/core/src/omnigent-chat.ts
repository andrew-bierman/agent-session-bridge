import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

import type { NormalizedContent, NormalizedMessage } from "./types.js";

const execFileAsync = promisify(execFile);

/**
 * Omnigent's own history lives in `<data dir>/chat.db`. Spec-defined sub-agents
 * (executor harness `codex` / `claude-sdk`) have no native bridge, so this is
 * the only place their sessions exist. These helpers read it (read-only) and
 * normalize `conversation_items` so the existing converters can write native
 * Codex / Claude sessions.
 *
 * Item types (verified against Omnigent 0.23.0): 1 message, 2 function_call,
 * 3 function_call_output, 8 event (skipped), others skipped. `created_at` is
 * epoch seconds.
 */
export interface OmnigentConversationInfo {
  id: string;
  parentId?: string;
  rootId?: string;
  kind: "default" | "sub_agent";
  subAgentName?: string;
  title?: string;
  workspace?: string;
  createdAt: string;
  updatedAt: string;
}

export interface OmnigentItemRow {
  id: string;
  created_at: number;
  position: number;
  type: number;
  data: string;
}

const HEX32 = /^[0-9a-f]{32}$/;

// `conversation_items.type` values that carry conversation content, and
// `omnigent_conversation_metadata.kind` for a sub-agent. Other item types
// (events, 8, and the rest) are skipped.
const ITEM_MESSAGE = 1;
const ITEM_FUNCTION_CALL = 2;
const ITEM_FUNCTION_OUTPUT = 3;
const KIND_SUB_AGENT = 2;

export function normalizeOmnigentConversationId(id: string): string {
  const hex = id.replaceAll("-", "").toLowerCase();
  if (!HEX32.test(hex)) {
    throw new Error(`Invalid Omnigent conversation id: ${id}`);
  }
  return hex;
}

async function queryJson<T>(dataDir: string, sql: string): Promise<T[]> {
  const dbPath = join(dataDir, "chat.db");
  await stat(dbPath);
  const { stdout } = await execFileAsync(
    "sqlite3",
    ["-readonly", "-json", dbPath, sql],
    { maxBuffer: 256 * 1024 * 1024 },
  );
  return stdout.trim() ? (JSON.parse(stdout) as T[]) : [];
}

const iso = (seconds: number | null | undefined): string =>
  new Date((seconds ?? 0) * 1000).toISOString();

export async function listOmnigentConversations(
  dataDir: string,
): Promise<OmnigentConversationInfo[]> {
  interface Row {
    id: string;
    parent: string | null;
    root: string | null;
    title: string | null;
    kind: number | null;
    sub_agent_name: string | null;
    workspace: string | null;
    created_at: number;
    updated_at: number;
  }
  let rows: Row[];
  try {
    rows = await queryJson<Row>(
      dataDir,
      `SELECT lower(hex(c.id)) AS id,
              lower(hex(c.parent_conversation_id)) AS parent,
              lower(hex(c.root_conversation_id)) AS root,
              c.title AS title, c.created_at AS created_at,
              c.updated_at AS updated_at,
              m.kind AS kind, m.sub_agent_name AS sub_agent_name,
              m.workspace AS workspace
         FROM conversations c
         LEFT JOIN omnigent_conversation_metadata m
           ON m.id = c.id AND m.workspace_id = c.workspace_id
        ORDER BY c.created_at;`,
    );
  } catch {
    return [];
  }
  return rows.map((row) => ({
    id: row.id,
    parentId: row.parent || undefined,
    rootId: row.root || undefined,
    kind: row.kind === KIND_SUB_AGENT ? "sub_agent" : "default",
    subAgentName: row.sub_agent_name || undefined,
    title: row.title || undefined,
    workspace: row.workspace || undefined,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  }));
}

function parseJson(text: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(text);
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function parseArguments(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    return raw as Record<string, unknown>;
  }
  if (typeof raw === "string") {
    const parsed = parseJson(raw);
    return parsed ?? { value: raw };
  }
  return {};
}

function messageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .flatMap((part) => {
      if (part && typeof part === "object") {
        const text = (part as { text?: unknown }).text;
        return typeof text === "string" ? [text] : [];
      }
      return [];
    })
    .join("\n");
}

/**
 * Convert raw `conversation_items` rows (any order) into normalized messages.
 * Tool calls and outputs are keyed by `call_id`: Omnigent can store the same
 * call more than once (e.g. a rejected dispatch retried with the same id), so a
 * later copy replaces the earlier one in the earlier one's position.
 */
export function omnigentItemsToMessages(
  rows: OmnigentItemRow[],
): NormalizedMessage[] {
  const ordered = [...rows].sort(
    (a, b) => a.position - b.position || a.created_at - b.created_at,
  );
  const slots: NormalizedMessage[] = [];
  const callSlot = new Map<string, number>();
  const outputSlot = new Map<string, number>();
  const callNames = new Map<string, string>();

  // A call or output seen again replaces the earlier copy's content in the
  // earlier copy's position; the first sighting appends.
  const upsert = (
    slotOf: Map<string, number>,
    callId: string,
    message: NormalizedMessage,
  ) => {
    const existing = slotOf.get(callId);
    if (existing !== undefined) {
      slots[existing] = { ...slots[existing]!, content: message.content };
    } else {
      slotOf.set(callId, slots.length);
      slots.push(message);
    }
  };

  for (const row of ordered) {
    const data = parseJson(row.data);
    if (!data) continue;
    const timestamp = iso(row.created_at);

    if (row.type === ITEM_MESSAGE) {
      const role = data.role === "assistant" ? "assistant" : "user";
      const text = messageText(data.content);
      if (!text.trim()) continue;
      slots.push({
        id: row.id,
        role,
        timestamp,
        content: [{ type: "text", text }],
      });
    } else if (row.type === ITEM_FUNCTION_CALL) {
      const callId = typeof data.call_id === "string" ? data.call_id : row.id;
      const name = typeof data.name === "string" ? data.name : "unknown";
      callNames.set(callId, name);
      const content: NormalizedContent[] = [
        {
          type: "tool_call",
          id: callId,
          name,
          arguments: parseArguments(data.arguments),
        },
      ];
      upsert(callSlot, callId, {
        id: row.id,
        role: "assistant",
        timestamp,
        content,
      });
    } else if (row.type === ITEM_FUNCTION_OUTPUT) {
      const callId = typeof data.call_id === "string" ? data.call_id : row.id;
      const output =
        typeof data.output === "string"
          ? data.output
          : JSON.stringify(data.output ?? "");
      const content: NormalizedContent[] = [
        {
          type: "tool_result",
          toolCallId: callId,
          toolName: callNames.get(callId),
          output,
        },
      ];
      upsert(outputSlot, callId, {
        id: row.id,
        role: "tool",
        timestamp,
        content,
      });
    }
  }

  // A tool result whose call never made it into history would be rejected by
  // Codex/Claude on resume, so drop orphans.
  return slots.filter((message) =>
    message.content.every(
      (c) => c.type !== "tool_result" || callSlot.has(c.toolCallId),
    ),
  );
}

export async function readOmnigentConversationMessages(
  dataDir: string,
  conversationId: string,
): Promise<NormalizedMessage[]> {
  const hex = normalizeOmnigentConversationId(conversationId);
  const rows = await queryJson<OmnigentItemRow>(
    dataDir,
    `SELECT lower(hex(id)) AS id, created_at, position, type, data
       FROM conversation_items
      WHERE conversation_id = x'${hex}';`,
  );
  return omnigentItemsToMessages(rows);
}

/**
 * Deterministic Codex-shaped (UUIDv7-looking) thread id for a conversation so
 * re-exporting the same conversation is idempotent.
 */
export function omnigentCodexThreadId(conversationId: string): string {
  const hex = createHash("sha1")
    .update(`omnigent:${normalizeOmnigentConversationId(conversationId)}`)
    .digest("hex")
    .split("");
  hex[12] = "7";
  hex[16] = ((Number.parseInt(hex[16]!, 16) & 0x3) | 0x8).toString(16);
  const h = hex.join("");
  return [
    h.slice(0, 8),
    h.slice(8, 12),
    h.slice(12, 16),
    h.slice(16, 20),
    h.slice(20, 32),
  ].join("-");
}
