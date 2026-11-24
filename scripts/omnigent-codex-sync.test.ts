import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import {
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

  it("skips rollouts without session_meta and ignores rollouts outside codex-home", () => {
    writeRollout(sessions(), "rollout-bad.jsonl", [{ type: "event_msg" }]);
    writeRollout(
      join(omnigent, "elsewhere"),
      "rollout-other.jsonl",
      validLines("zzz"),
    );
    const r = run("--apply");
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("skip (no session_meta)");
    expect(r.stdout).toContain("1 rollouts found, 0 synced, 1 skipped");
    expect(rows()).toBe("");
  });

  it("handles a missing Omnigent data dir", () => {
    const r = run();
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("0 rollouts found");
  });
});
