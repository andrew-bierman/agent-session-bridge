import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const script = join(import.meta.dirname, "omnigent-chat-export.ts");
const PARENT = "d6685f49d34a4223a093a4634ab58b49";
const CHILD = "2e5088fd2c8342809cdb73c755a6fcca";

let root: string;
let omnigent: string;
let codexHome: string;
let claudeHome: string;

function run(...extra: string[]) {
  return spawnSync(
    "bun",
    [
      script,
      "--omnigent-data",
      omnigent,
      "--codex-home",
      codexHome,
      "--claude-home",
      claudeHome,
      "--cwd",
      "/work/demo",
      ...extra,
    ],
    { encoding: "utf8" },
  );
}

function threads() {
  return execFileSync(
    "sqlite3",
    [
      join(codexHome, "state_5.sqlite"),
      "select cwd, preview, model_provider from threads order by id;",
    ],
    { encoding: "utf8" },
  ).trim();
}

function rolloutFiles(): string[] {
  const base = join(codexHome, "sessions");
  if (!existsSync(base)) return [];
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory()) walk(join(dir, e.name));
      else out.push(join(dir, e.name));
    }
  };
  walk(base);
  return out;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "omni-export-"));
  omnigent = join(root, "omnigent");
  codexHome = join(root, "home", ".codex");
  claudeHome = join(root, "home");
  mkdirSync(omnigent, { recursive: true });
  mkdirSync(codexHome, { recursive: true });
  execFileSync("sqlite3", [
    join(codexHome, "state_5.sqlite"),
    `CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, source TEXT NOT NULL, model_provider TEXT NOT NULL, cwd TEXT NOT NULL, title TEXT NOT NULL, sandbox_policy TEXT NOT NULL, approval_mode TEXT NOT NULL, tokens_used INTEGER NOT NULL DEFAULT 0, has_user_event INTEGER NOT NULL DEFAULT 0, archived INTEGER NOT NULL DEFAULT 0, cli_version TEXT NOT NULL DEFAULT '', first_user_message TEXT NOT NULL DEFAULT '', memory_mode TEXT NOT NULL DEFAULT 'enabled', model TEXT, reasoning_effort TEXT, preview TEXT NOT NULL DEFAULT '');`,
  ]);
  execFileSync("sqlite3", [
    join(omnigent, "chat.db"),
    `CREATE TABLE conversations (id BLOB NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, title TEXT, parent_conversation_id BLOB, root_conversation_id BLOB NOT NULL, workspace_id INTEGER NOT NULL DEFAULT 0);
     CREATE TABLE omnigent_conversation_metadata (workspace_id INTEGER NOT NULL DEFAULT 0, id BLOB NOT NULL, kind INTEGER NOT NULL DEFAULT 1, sub_agent_name TEXT, workspace TEXT);
     CREATE TABLE conversation_items (id BLOB NOT NULL, conversation_id BLOB NOT NULL, created_at INTEGER NOT NULL, position INTEGER NOT NULL, data TEXT NOT NULL, type SMALLINT NOT NULL);
     INSERT INTO conversations VALUES (x'${PARENT}', 1795487412, 1795487500, 'Herdwick', NULL, x'${PARENT}', 0);
     INSERT INTO conversations VALUES (x'${CHILD}', 1795487420, 1795487480, 'gpt:cli-name-gpt', x'${PARENT}', x'${PARENT}', 0);
     INSERT INTO omnigent_conversation_metadata VALUES (0, x'${PARENT}', 1, NULL, NULL);
     INSERT INTO omnigent_conversation_metadata VALUES (0, x'${CHILD}', 2, 'gpt', NULL);
     INSERT INTO conversation_items VALUES (x'01', x'${CHILD}', 1795487421, 0, '{"role":"user","content":[{"type":"input_text","text":"Give me a CLI name"}]}', 1);
     INSERT INTO conversation_items VALUES (x'02', x'${CHILD}', 1795487422, 1, '{"name":"sh","arguments":"{\\"cmd\\":\\"ls\\"}","call_id":"c1"}', 2);
     INSERT INTO conversation_items VALUES (x'03', x'${CHILD}', 1795487423, 2, '{"call_id":"c1","output":"a.txt"}', 3);
     INSERT INTO conversation_items VALUES (x'04', x'${CHILD}', 1795487425, 3, '{"role":"assistant","content":[{"type":"output_text","text":"Runcrew"}]}', 1);
     INSERT INTO conversation_items VALUES (x'05', x'${PARENT}', 1795487413, 0, '{"role":"user","content":[{"type":"input_text","text":"parent prompt"}]}', 1);`,
  ]);
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("omnigent-chat-export", () => {
  it("requires a valid --target", () => {
    const r = run();
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("--target codex|claude is required");
  });

  it.each([
    [
      "--conversation with no value",
      ["--target", "codex", "--apply", "--conversation"],
    ],
    [
      "--conversation with an empty value",
      ["--target", "codex", "--apply", "--conversation", ""],
    ],
    [
      "--conversation followed by another flag",
      ["--target", "codex", "--conversation", "--apply"],
    ],
    ["--target with no value", ["--target"]],
  ])("rejects %s instead of selecting every conversation", (_name, extra) => {
    const r = run(...extra);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("needs a value");
    expect(existsSync(join(codexHome, "sessions"))).toBe(false);
  });

  it("rejects a trailing --cwd with no value", () => {
    const r = spawnSync(
      "bun",
      [script, "--omnigent-data", omnigent, "--target", "codex", "--cwd"],
      { encoding: "utf8" },
    );
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("--cwd needs a value");
  });

  it("dry run lists sub-agent conversations and writes nothing", () => {
    const r = run("--target", "codex", "--sub-agents-only");
    expect(r.status).toBe(0);
    expect(r.stdout).toContain(`[sub-agent gpt of ${PARENT}]`);
    expect(r.stdout).toContain("1 conversations, 0 exported");
    expect(rolloutFiles()).toEqual([]);
    expect(threads()).toBe("");
    expect(readdirSync(codexHome)).toEqual(["state_5.sqlite"]);
  });

  it("exports a sub-agent to a native Codex rollout and indexes it for resume", () => {
    const r = run("--target", "codex", "--sub-agents-only", "--apply");
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("backed up state_5.sqlite");
    const files = rolloutFiles();
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(
      /rollout-2026-11-\d\dT[\d-]+-[0-9a-f-]{36}\.jsonl$/,
    );
    const lines = readFileSync(files[0]!, "utf8")
      .trim()
      .split("\n")
      .map(
        (l) =>
          JSON.parse(l) as { type: string; payload: Record<string, unknown> },
      );
    expect(lines[0]!.type).toBe("session_meta");
    expect(lines[0]!.payload.cwd).toBe("/work/demo");
    const body = lines.map((l) => JSON.stringify(l)).join("\n");
    expect(body).toContain("Give me a CLI name");
    expect(body).toContain("Runcrew");
    expect(body).toContain("function_call_output");
    expect(threads()).toContain("/work/demo|Give me a CLI name|");
  });

  it("is idempotent and never overwrites an existing export", () => {
    run("--target", "codex", "--conversation", CHILD, "--apply");
    const before = readFileSync(rolloutFiles()[0]!, "utf8");
    const again = run("--target", "codex", "--conversation", CHILD, "--apply");
    expect(again.stdout).toContain("skip (already present)");
    expect(again.stdout).toContain("0 exported");
    expect(rolloutFiles()).toHaveLength(1);
    expect(readFileSync(rolloutFiles()[0]!, "utf8")).toBe(before);
    expect(threads().split("\n")).toHaveLength(1);
  });

  it("--conversation accepts dashed ids and selects only that conversation", () => {
    const dashed = `${CHILD.slice(0, 8)}-${CHILD.slice(8, 12)}-${CHILD.slice(12, 16)}-${CHILD.slice(16, 20)}-${CHILD.slice(20)}`;
    const r = run("--target", "codex", "--conversation", dashed);
    expect(r.stdout).toContain("1 conversations");
    expect(r.stdout).not.toContain(PARENT + " ");
  });

  it("exits non-zero without writing when a requested conversation is not in chat.db", () => {
    const r = run(
      "--target",
      "codex",
      "--conversation",
      "ffffffffffffffffffffffffffffffff",
      "--apply",
    );
    expect(r.status).toBe(1);
    expect(r.stderr).toContain(
      "conversation not found in chat.db: ffffffffffffffffffffffffffffffff",
    );
    expect(rolloutFiles()).toEqual([]);
    expect(threads()).toBe("");
  });

  it("exports all conversations when no filter is given", () => {
    const r = run("--target", "codex", "--apply");
    expect(rolloutFiles()).toHaveLength(2);
    expect(r.stdout).toContain("2 conversations, 2 exported");
    expect(threads().split("\n")).toHaveLength(2);
  });

  it("skips conversations that have no messages", () => {
    execFileSync("sqlite3", [
      join(omnigent, "chat.db"),
      `DELETE FROM conversation_items WHERE conversation_id = x'${PARENT}';`,
    ]);
    const r = run("--target", "codex", "--apply");
    expect(r.stdout).toContain(`skip (no messages): ${PARENT}`);
    expect(rolloutFiles()).toHaveLength(1);
  });

  it("exports a Claude Code session with linked parentUuid and tool blocks", () => {
    const r = run("--target", "claude", "--conversation", CHILD, "--apply");
    expect(r.status).toBe(0);
    const dir = join(claudeHome, ".claude", "projects", "-work-demo");
    const [file] = readdirSync(dir);
    expect(file).toMatch(/^[0-9a-f-]{36}\.jsonl$/);
    const lines = readFileSync(join(dir, file!), "utf8")
      .trim()
      .split("\n")
      .map(
        (l) =>
          JSON.parse(l) as {
            uuid: string;
            parentUuid: string | null;
            sessionId: string;
            message: { content: { type: string }[] };
          },
      );
    expect(lines).toHaveLength(4);
    expect(lines[0]!.parentUuid).toBeNull();
    expect(lines[1]!.parentUuid).toBe(lines[0]!.uuid);
    expect(
      lines.every((l) => l.sessionId === file!.replace(".jsonl", "")),
    ).toBe(true);
    expect(lines[1]!.message.content[0]!.type).toBe("tool_use");
    expect(lines[2]!.message.content[0]!.type).toBe("tool_result");
    const again = run("--target", "claude", "--conversation", CHILD, "--apply");
    expect(again.stdout).toContain("skip (already present)");
  });

  it("handles a missing chat.db", () => {
    rmSync(join(omnigent, "chat.db"));
    const r = run("--target", "codex");
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("0 conversations");
  });
});
