import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  readFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const script = join(import.meta.dirname, "omnigent-codex-sync.ts");
const THREAD = "01a20700-eaa3-7000-b1a9-aaaaaaaaaaaa";

let root: string;
let omnigent: string;
let codexHome: string;

function writeRollout(dir: string, name: string, lines: unknown[]): string {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, name);
  writeFileSync(path, `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`);
  return path;
}

function validLines(id: string) {
  return [
    {
      timestamp: "2026-11-23T06:03:50.350Z",
      type: "session_meta",
      payload: {
        id,
        timestamp: "2026-11-23T06:03:50.350Z",
        cwd: "/work/demo",
        cli_version: "0.171.0",
        source: "vscode",
        model_provider: "openai",
      },
    },
    {
      timestamp: "2026-11-23T06:03:51.000Z",
      type: "turn_context",
      payload: { model: "gpt-6", approval_policy: "on-request", effort: "low" },
    },
    {
      timestamp: "2026-11-23T06:03:52.000Z",
      type: "response_item",
      payload: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "Say ok" }],
      },
    },
  ];
}

function run(...extra: string[]) {
  return spawnSync(
    "bun",
    [script, "--omnigent-data", omnigent, "--codex-home", codexHome, ...extra],
    { encoding: "utf8" },
  );
}

function rows() {
  return execFileSync(
    "sqlite3",
    [
      join(codexHome, "state_5.sqlite"),
      "select id, cli_version, model, preview from threads order by id;",
    ],
    { encoding: "utf8" },
  ).trim();
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "omni-sync-"));
  omnigent = join(root, "omnigent");
  codexHome = join(root, "home", ".codex");
  mkdirSync(codexHome, { recursive: true });
  execFileSync("sqlite3", [
    join(codexHome, "state_5.sqlite"),
    `CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, source TEXT NOT NULL, model_provider TEXT NOT NULL, cwd TEXT NOT NULL, title TEXT NOT NULL, sandbox_policy TEXT NOT NULL, approval_mode TEXT NOT NULL, tokens_used INTEGER NOT NULL DEFAULT 0, has_user_event INTEGER NOT NULL DEFAULT 0, archived INTEGER NOT NULL DEFAULT 0, cli_version TEXT NOT NULL DEFAULT '', first_user_message TEXT NOT NULL DEFAULT '', memory_mode TEXT NOT NULL DEFAULT 'enabled', model TEXT, reasoning_effort TEXT, preview TEXT NOT NULL DEFAULT '');`,
  ]);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("omnigent-codex-sync", () => {
  const sessions = () =>
    join(
      omnigent,
      "codex-native",
      "abc",
      "codex-home",
      "sessions",
      "2026",
      "11",
      "23",
    );

  it("dry run reports sessions but changes nothing", () => {
    writeRollout(sessions(), `rollout-x-${THREAD}.jsonl`, validLines(THREAD));
    const r = run();
    expect(r.status).toBe(0);
    expect(r.stdout).toContain(`would sync: ${THREAD}`);
    expect(r.stdout).toContain("(dry run)");
    expect(rows()).toBe("");
    expect(readdirSync(codexHome)).toEqual(["state_5.sqlite"]);
  });

  it("apply copies the rollout, indexes it from rollout metadata, and backs up the DB", () => {
    writeRollout(sessions(), `rollout-x-${THREAD}.jsonl`, validLines(THREAD));
    const r = run("--apply");
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("backed up state_5.sqlite");
    expect(rows()).toBe(`${THREAD}|0.171.0|gpt-6|Say ok`);
    expect(
      readdirSync(join(codexHome, "sessions", "2026", "11", "23")),
    ).toEqual([`rollout-x-${THREAD}.jsonl`]);
    expect(
      readdirSync(codexHome).some((f) => f.startsWith("state_5.sqlite.bak-")),
    ).toBe(true);
  });

  it("is idempotent when re-run", () => {
    writeRollout(sessions(), `rollout-x-${THREAD}.jsonl`, validLines(THREAD));
    run("--apply");
    const again = run("--apply");
    expect(again.status).toBe(0);
    expect(again.stdout).toContain(`skip (already present): ${THREAD}`);
    expect(again.stdout).toContain("0 synced");
    expect(rows().split("\n")).toHaveLength(1);
  });

  it("ignores rollouts without session_meta and outside codex-native bridges", () => {
    writeRollout(sessions(), "rollout-bad.jsonl", [{ type: "event_msg" }]);
    writeRollout(
      join(omnigent, "elsewhere"),
      "rollout-other.jsonl",
      validLines("zzz"),
    );
    const r = run("--apply");
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("0 rollouts found");
    expect(rows()).toBe("");
  });

  it("labels sub-agent sessions and --sub-agents-only filters to them", () => {
    const PARENT = "878cab88463741a5a98dfd0db03b5959";
    const CHILD = "aa31d2d83f174fe18b189f2b0b9528b5";
    const dirFor = (id: string) =>
      join(
        omnigent,
        "codex-native",
        createHash("sha256").update(id).digest("hex").slice(0, 32),
        "codex-home",
        "sessions",
        "2026",
        "11",
        "23",
      );
    writeRollout(
      dirFor(PARENT),
      "rollout-p-parent.jsonl",
      validLines("parent-t"),
    );
    writeRollout(dirFor(CHILD), "rollout-c-child.jsonl", validLines("child-t"));
    execFileSync("sqlite3", [
      join(omnigent, "chat.db"),
      `CREATE TABLE conversations (id BLOB NOT NULL, title TEXT, parent_conversation_id BLOB, root_conversation_id BLOB NOT NULL, workspace_id INTEGER NOT NULL DEFAULT 0);
       CREATE TABLE omnigent_conversation_metadata (workspace_id INTEGER NOT NULL DEFAULT 0, id BLOB NOT NULL, kind INTEGER NOT NULL DEFAULT 1, sub_agent_name TEXT);
       INSERT INTO conversations VALUES (x'${PARENT}', 'P', NULL, x'${PARENT}', 0);
       INSERT INTO conversations VALUES (x'${CHILD}', 'C', x'${PARENT}', x'${PARENT}', 0);
       INSERT INTO omnigent_conversation_metadata VALUES (0, x'${PARENT}', 1, NULL);
       INSERT INTO omnigent_conversation_metadata VALUES (0, x'${CHILD}', 2, 'reviewer');`,
    ]);
    const all = run();
    expect(all.stdout).toContain(
      `child-t  /work/demo [sub-agent reviewer of ${PARENT}]`,
    );
    expect(all.stdout).toContain("2 rollouts found");
    const only = run("--sub-agents-only");
    expect(only.stdout).toContain("1 rollouts found");
    expect(only.stdout).not.toContain("parent-t");
  });

  it("handles a missing Omnigent data dir", () => {
    const r = run();
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("0 rollouts found");
  });

  it("never overwrites a rollout that already exists in the native home", () => {
    writeRollout(sessions(), `rollout-x-${THREAD}.jsonl`, validLines(THREAD));
    const nativeDir = join(codexHome, "sessions", "2026", "11", "23");
    mkdirSync(nativeDir, { recursive: true });
    const existing = join(nativeDir, `rollout-x-${THREAD}.jsonl`);
    writeFileSync(existing, "user-owned content\n");
    const r = run("--apply");
    expect(r.status).toBe(0);
    expect(readFileSync(existing, "utf8")).toBe("user-owned content\n");
    expect(r.stdout).toContain("0 synced");
  });

  it("syncs a session that never got a user message", () => {
    const lines = validLines(THREAD).slice(0, 2);
    writeRollout(sessions(), `rollout-x-${THREAD}.jsonl`, lines);
    const r = run("--apply");
    expect(r.status).toBe(0);
    expect(rows()).toBe(`${THREAD}|0.171.0|gpt-6|`);
  });

  it("fails without writing anything when the native home does not exist", () => {
    writeRollout(sessions(), `rollout-x-${THREAD}.jsonl`, validLines(THREAD));
    const missing = join(root, "nowhere", ".codex");
    const r = spawnSync(
      "bun",
      [script, "--omnigent-data", omnigent, "--codex-home", missing, "--apply"],
      { encoding: "utf8" },
    );
    expect(r.status).not.toBe(0);
    expect(existsSync(missing)).toBe(false);
  });
});
