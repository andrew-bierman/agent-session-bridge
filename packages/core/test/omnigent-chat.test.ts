import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  isCodexThreadId,
  listOmnigentConversations,
  NO_OUTPUT_TEXT,
  normalizeOmnigentConversationId,
  omnigentCodexThreadId,
  omnigentItemsToMessages,
  readOmnigentConversationMessages,
  type OmnigentItemRow,
} from "../src/index.js";

const PARENT = "d6685f49d34a4223a093a4634ab58b49";
const CHILD = "2e5088fd2c8342809cdb73c755a6fcca";

const row = (
  position: number,
  type: number,
  data: unknown,
  id = `item${position}`,
  created_at = 1795487412 + position,
): OmnigentItemRow => ({
  id,
  created_at,
  position,
  type,
  data: typeof data === "string" ? data : JSON.stringify(data),
});

describe("omnigentItemsToMessages", () => {
  it("maps messages, tool calls and outputs in position order", () => {
    const messages = omnigentItemsToMessages([
      row(3, 3, { call_id: "c1", output: "done" }),
      row(1, 1, {
        role: "user",
        content: [{ type: "input_text", text: "hi" }],
      }),
      row(2, 2, { name: "sh", arguments: '{"cmd":"ls"}', call_id: "c1" }),
      row(4, 1, {
        role: "assistant",
        content: [{ type: "output_text", text: "ok" }],
      }),
    ]);
    expect(messages.map((m) => m.role)).toEqual([
      "user",
      "assistant",
      "tool",
      "assistant",
    ]);
    expect(messages[1]!.content).toEqual([
      { type: "tool_call", id: "c1", name: "sh", arguments: { cmd: "ls" } },
    ]);
    expect(messages[2]!.content).toEqual([
      { type: "tool_result", toolCallId: "c1", toolName: "sh", output: "done" },
    ]);
    expect(messages[0]!.timestamp).toBe(
      new Date(1795487413 * 1000).toISOString(),
    );
  });

  it("pairs a tool call that never got an output with an error result", () => {
    const messages = omnigentItemsToMessages([
      row(1, 1, {
        role: "user",
        content: [{ type: "input_text", text: "go" }],
      }),
      row(2, 2, { name: "sh", arguments: "{}", call_id: "lost" }),
      row(3, 2, { name: "sh", arguments: "{}", call_id: "kept" }),
      row(4, 3, { call_id: "kept", output: "done" }),
    ]);
    expect(messages.map((m) => m.role)).toEqual([
      "user",
      "assistant",
      "tool",
      "assistant",
      "tool",
    ]);
    expect(messages[2]!.content).toEqual([
      {
        type: "tool_result",
        toolCallId: "lost",
        toolName: "sh",
        output: NO_OUTPUT_TEXT,
        isError: true,
      },
    ]);
    expect(messages[4]!.content[0]).toMatchObject({ output: "done" });
  });

  it("skips events, unknown types, empty text and malformed JSON", () => {
    const messages = omnigentItemsToMessages([
      row(0, 8, { event_type: "session.resource.created" }),
      row(1, 5, { anything: true }),
      row(2, 1, {
        role: "user",
        content: [{ type: "input_text", text: "  " }],
      }),
      row(3, 1, "{not json"),
      row(4, 1, "[1,2]"),
      row(5, 1, { role: "user", content: [{ type: "input_text", text: "x" }] }),
    ]);
    expect(messages).toHaveLength(1);
  });

  it("replaces a repeated call_id in place instead of duplicating it", () => {
    const messages = omnigentItemsToMessages([
      row(1, 2, {
        name: "send",
        arguments: '{"agent":"claude"}',
        call_id: "c",
      }),
      row(2, 3, { call_id: "c", output: "rejected" }),
      row(3, 2, { name: "send", arguments: '{"agent":"gpt"}', call_id: "c" }),
      row(4, 3, { call_id: "c", output: "launched" }),
    ]);
    expect(messages).toHaveLength(2);
    expect(messages[0]!.content[0]).toMatchObject({
      type: "tool_call",
      arguments: { agent: "gpt" },
    });
    expect(messages[1]!.content[0]).toMatchObject({ output: "launched" });
  });

  it("drops tool outputs whose call is missing", () => {
    expect(
      omnigentItemsToMessages([row(1, 3, { call_id: "ghost", output: "x" })]),
    ).toEqual([]);
  });

  it("tolerates object arguments, bad argument JSON and non-string output", () => {
    const messages = omnigentItemsToMessages([
      row(1, 2, { name: "a", arguments: { k: 1 }, call_id: "1" }),
      row(2, 2, { name: "b", arguments: "plain text", call_id: "2" }),
      row(3, 2, { name: "c", call_id: "3" }),
      row(4, 3, { call_id: "1", output: { ok: true } }),
    ]);
    const calls = messages.filter((m) => m.role === "assistant");
    expect(calls[0]!.content[0]).toMatchObject({ arguments: { k: 1 } });
    expect(calls[1]!.content[0]).toMatchObject({
      arguments: { value: "plain text" },
    });
    expect(calls[2]!.content[0]).toMatchObject({ arguments: {} });
    const output = messages.find(
      (m) =>
        m.content[0]?.type === "tool_result" && m.content[0].toolCallId === "1",
    );
    expect(output!.content[0]).toMatchObject({ output: '{"ok":true}' });
  });

  it("accepts string message content", () => {
    const [m] = omnigentItemsToMessages([
      row(1, 1, { role: "assistant", content: "plain" }),
    ]);
    expect(m!.content).toEqual([{ type: "text", text: "plain" }]);
  });
});

describe("conversation ids", () => {
  it("normalizes dashed/uppercase ids and rejects junk", () => {
    expect(
      normalizeOmnigentConversationId("D6685F49-D34A-4223-A093-A4634AB58B49"),
    ).toBe(PARENT);
    expect(() =>
      normalizeOmnigentConversationId("x'; DROP TABLE y;--"),
    ).toThrow("Invalid Omnigent conversation id");
  });

  it("derives a stable Codex-shaped thread id per conversation", () => {
    const a = omnigentCodexThreadId(PARENT);
    expect(a).toBe(omnigentCodexThreadId(PARENT.toUpperCase()));
    expect(a).not.toBe(omnigentCodexThreadId(CHILD));
    expect(isCodexThreadId(a)).toBe(true);
  });
});

describe("chat.db reader", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "omni-chat-"));
    mkdirSync(root, { recursive: true });
    execFileSync("sqlite3", [
      join(root, "chat.db"),
      `CREATE TABLE conversations (id BLOB NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, title TEXT, parent_conversation_id BLOB, root_conversation_id BLOB NOT NULL, workspace_id INTEGER NOT NULL DEFAULT 0);
       CREATE TABLE omnigent_conversation_metadata (workspace_id INTEGER NOT NULL DEFAULT 0, id BLOB NOT NULL, kind INTEGER NOT NULL DEFAULT 1, sub_agent_name TEXT, workspace TEXT);
       CREATE TABLE conversation_items (id BLOB NOT NULL, conversation_id BLOB NOT NULL, created_at INTEGER NOT NULL, position INTEGER NOT NULL, data TEXT NOT NULL, type SMALLINT NOT NULL);
       INSERT INTO conversations VALUES (x'${PARENT}', 1795487412, 1795487500, 'Herdwick', NULL, x'${PARENT}', 0);
       INSERT INTO conversations VALUES (x'${CHILD}', 1795487420, 1795487480, 'gpt:cli-name-gpt', x'${PARENT}', x'${PARENT}', 0);
       INSERT INTO omnigent_conversation_metadata VALUES (0, x'${PARENT}', 1, NULL, '/work/demo');
       INSERT INTO omnigent_conversation_metadata VALUES (0, x'${CHILD}', 2, 'gpt', NULL);
       INSERT INTO conversation_items VALUES (x'01', x'${CHILD}', 1795487421, 0, '{"role":"user","content":[{"type":"input_text","text":"name?"}]}', 1);
       INSERT INTO conversation_items VALUES (x'02', x'${CHILD}', 1795487425, 1, '{"role":"assistant","content":[{"type":"output_text","text":"Runcrew"}]}', 1);
       INSERT INTO conversation_items VALUES (x'03', x'${PARENT}', 1795487413, 0, '{"role":"user","content":[{"type":"input_text","text":"parent only"}]}', 1);`,
    ]);
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("lists conversations with parent links, kind, sub-agent name and workspace", async () => {
    const list = await listOmnigentConversations(root);
    expect(list).toHaveLength(2);
    const child = list.find((c) => c.id === CHILD)!;
    expect(child).toMatchObject({
      parentId: PARENT,
      rootId: PARENT,
      kind: "sub_agent",
      subAgentName: "gpt",
      title: "gpt:cli-name-gpt",
    });
    const parent = list.find((c) => c.id === PARENT)!;
    expect(parent).toMatchObject({ kind: "default", workspace: "/work/demo" });
    expect(parent.createdAt).toBe(new Date(1795487412 * 1000).toISOString());
  });

  it("reads only the requested conversation's messages", async () => {
    const messages = await readOmnigentConversationMessages(root, CHILD);
    expect(messages.map((m) => [m.role, m.content[0]])).toEqual([
      ["user", { type: "text", text: "name?" }],
      ["assistant", { type: "text", text: "Runcrew" }],
    ]);
    expect(await readOmnigentConversationMessages(root, PARENT)).toHaveLength(
      1,
    );
  });

  it("returns nothing for a missing db and rejects invalid ids before querying", async () => {
    expect(await listOmnigentConversations(join(root, "nope"))).toEqual([]);
    await expect(
      readOmnigentConversationMessages(root, "1' OR '1'='1"),
    ).rejects.toThrow("Invalid Omnigent conversation id");
  });
});
