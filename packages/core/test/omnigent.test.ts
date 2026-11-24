import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  listOmnigentCodexSessions,
  omnigentBridgeHash,
  omnigentDataDir,
} from "../src/omnigent.js";

const PARENT = "878cab88463741a5a98dfd0db03b5959";
const CHILD = "aa31d2d83f174fe18b189f2b0b9528b5";
const LONE = "2def821cb317447793d2b8c30f7c5f86";

let dataDir: string;

function rollout(conversationId: string, threadId: string, cwd = "/work") {
  const dir = join(
    dataDir,
    "codex-native",
    omnigentBridgeHash(conversationId),
    "codex-home",
    "sessions",
    "2026",
    "11",
    "23",
  );
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `rollout-2026-11-23T01-00-00-${threadId}.jsonl`),
    `${JSON.stringify({
      type: "session_meta",
      payload: { id: threadId, cwd, timestamp: "2026-11-23T01:00:00.000Z" },
    })}\n`,
  );
}

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "omnigent-locator-"));
});
afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

describe("omnigent locator", () => {
  it("hashes conversation ids like Omnigent's bridge dirs", () => {
    // Verified against real Omnigent 0.23.0 bridge directories.
    expect(omnigentBridgeHash(PARENT)).toBe("c0b410c9f9dd3e7b197ca74f9d742f42");
    expect(omnigentBridgeHash(CHILD)).toBe("b55a76546f992dd2ac9f3dc9b64adfc4");
    expect(omnigentBridgeHash("AA31D2D8-3F17-4FE1-8B18-9F2B0B9528B5")).toBe(
      omnigentBridgeHash(CHILD),
    );
  });

  it("resolves the data dir from OMNIGENT_DATA_DIR or ~/.omnigent", () => {
    expect(omnigentDataDir({ OMNIGENT_DATA_DIR: "/x/y" }, "/home/u")).toBe(
      "/x/y",
    );
    expect(omnigentDataDir({}, "/home/u")).toBe("/home/u/.omnigent");
  });

  it("returns nothing when there is no codex-native dir", async () => {
    expect(await listOmnigentCodexSessions(dataDir)).toEqual([]);
  });

  it("lists sessions without chat.db, unlinked", async () => {
    rollout(LONE, "thread-lone");
    const sessions = await listOmnigentCodexSessions(dataDir);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({
      tool: "codex",
      threadId: "thread-lone",
      cwd: "/work",
      startedAt: "2026-11-23T01:00:00.000Z",
      bridgeHash: omnigentBridgeHash(LONE),
    });
    expect(sessions[0]?.kind).toBeUndefined();
    expect(sessions[0]?.parentConversationId).toBeUndefined();
  });

  it("links sub-agent sessions to their parent via chat.db", async () => {
    rollout(PARENT, "thread-parent");
    rollout(CHILD, "thread-child");
    rollout(LONE, "thread-lone");
    execFileSync("sqlite3", [
      join(dataDir, "chat.db"),
      `CREATE TABLE conversations (id BLOB NOT NULL, title TEXT, parent_conversation_id BLOB, root_conversation_id BLOB NOT NULL, workspace_id INTEGER NOT NULL DEFAULT 0);
       CREATE TABLE omnigent_conversation_metadata (workspace_id INTEGER NOT NULL DEFAULT 0, id BLOB NOT NULL, kind INTEGER NOT NULL DEFAULT 1, sub_agent_name TEXT);
       INSERT INTO conversations VALUES (x'${PARENT}', 'Parent task', NULL, x'${PARENT}', 0);
       INSERT INTO conversations VALUES (x'${CHILD}', 'Child task', x'${PARENT}', x'${PARENT}', 0);
       INSERT INTO conversations VALUES (x'${LONE}', 'Standalone', NULL, x'${LONE}', 0);
       INSERT INTO omnigent_conversation_metadata VALUES (0, x'${PARENT}', 1, NULL);
       INSERT INTO omnigent_conversation_metadata VALUES (0, x'${CHILD}', 2, 'reviewer');
       INSERT INTO omnigent_conversation_metadata VALUES (0, x'${LONE}', 1, NULL);`,
    ]);

    const byThread = new Map(
      (await listOmnigentCodexSessions(dataDir)).map((s) => [s.threadId, s]),
    );
    expect(byThread.get("thread-child")).toMatchObject({
      kind: "sub_agent",
      subAgentName: "reviewer",
      parentConversationId: PARENT,
      rootConversationId: PARENT,
      title: "Child task",
    });
    expect(byThread.get("thread-parent")).toMatchObject({
      kind: "default",
      conversationId: PARENT,
      title: "Parent task",
    });
    expect(byThread.get("thread-parent")?.parentConversationId).toBeUndefined();
    expect(byThread.get("thread-lone")?.kind).toBe("default");
  });

  it("skips rollouts without session_meta and tolerates a corrupt chat.db", async () => {
    rollout(LONE, "thread-lone");
    const dir = join(
      dataDir,
      "codex-native",
      omnigentBridgeHash(PARENT),
      "codex-home",
      "sessions",
    );
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "rollout-bad.jsonl"), '{"type":"event_msg"}\n');
    writeFileSync(join(dataDir, "chat.db"), "not a database");
    const sessions = await listOmnigentCodexSessions(dataDir);
    expect(sessions.map((s) => s.threadId)).toEqual(["thread-lone"]);
  });
});
