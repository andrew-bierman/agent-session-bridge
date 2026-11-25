import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  backupNewestCodexState,
  exportClaudeSession,
  exportCodexSession,
} from "../src/native-export.js";
import type { NormalizedMessage } from "../src/types.js";

const SESSION = "01a20bd7-c82b-7000-b619-d10335d3ce3e";
const messages: NormalizedMessage[] = [
  {
    id: "u1",
    role: "user",
    timestamp: "2026-11-24T01:00:00.000Z",
    content: [{ type: "text", text: "hello export" }],
  },
  {
    id: "a1",
    role: "assistant",
    timestamp: "2026-11-24T01:00:01.000Z",
    content: [{ type: "text", text: "hi there" }],
  },
];

let home: string;
let codexHome: string;

const createThreadIndex = () =>
  execFileSync("sqlite3", [
    join(codexHome, "state_5.sqlite"),
    `CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, source TEXT NOT NULL, model_provider TEXT NOT NULL, cwd TEXT NOT NULL, title TEXT NOT NULL, sandbox_policy TEXT NOT NULL, approval_mode TEXT NOT NULL, tokens_used INTEGER NOT NULL DEFAULT 0, has_user_event INTEGER NOT NULL DEFAULT 0, archived INTEGER NOT NULL DEFAULT 0, cli_version TEXT NOT NULL DEFAULT '', first_user_message TEXT NOT NULL DEFAULT '', memory_mode TEXT NOT NULL DEFAULT 'enabled', model TEXT, reasoning_effort TEXT, preview TEXT NOT NULL DEFAULT '');`,
  ]);

const threadIds = () =>
  execFileSync(
    "sqlite3",
    [join(codexHome, "state_5.sqlite"), "select id from threads;"],
    { encoding: "utf8" },
  ).trim();

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "native-export-"));
  codexHome = join(home, ".codex");
  mkdirSync(codexHome, { recursive: true });
});

afterEach(() => rmSync(home, { recursive: true, force: true }));

const exportCodex = () =>
  exportCodexSession({
    messages,
    cwd: "/work/demo",
    sessionId: SESSION,
    codexHome,
    homeDir: home,
  });

describe("exportCodexSession", () => {
  it("indexes a rollout that an earlier run wrote before Codex had a thread database", async () => {
    const first = await exportCodex();
    expect(first.status).toBe("exported");
    expect(first.indexed).toMatchObject({
      indexed: false,
      reason: "missing-db",
    });

    createThreadIndex();
    const again = await exportCodex();
    expect(again.status).toBe("exists");
    expect(again.indexed?.indexed).toBe(true);
    expect(threadIds()).toBe(SESSION);
  });

  it("leaves one thread row and an unchanged rollout when re-run after indexing", async () => {
    createThreadIndex();
    const first = await exportCodex();
    const before = await Bun.file(first.rolloutPath).text();
    const again = await exportCodex();
    expect(again.status).toBe("exists");
    expect(await Bun.file(first.rolloutPath).text()).toBe(before);
    expect(threadIds()).toBe(SESSION);
  });

  it("writes the rollout through a temporary file, leaving only the rollout behind", async () => {
    createThreadIndex();
    const { rolloutPath } = await exportCodex();
    expect(readdirSync(dirname(rolloutPath))).toEqual([
      rolloutPath.split("/").at(-1),
    ]);
  });

  it("refuses a conversation with no messages", async () => {
    await expect(
      exportCodexSession({
        messages: [],
        cwd: "/work/demo",
        sessionId: SESSION,
        codexHome,
        homeDir: home,
      }),
    ).rejects.toThrow("no messages");
  });
});

describe("exportClaudeSession", () => {
  const params = () => ({
    messages,
    cwd: "/work/demo",
    sessionId: SESSION,
    homeDir: home,
  });

  it("writes the session once, through a temporary file, and reports exists on a re-run", async () => {
    const first = await exportClaudeSession(params());
    expect(first.status).toBe("exported");
    expect(readdirSync(dirname(first.sessionPath))).toEqual([
      `${SESSION}.jsonl`,
    ]);
    const before = await Bun.file(first.sessionPath).text();
    const again = await exportClaudeSession(params());
    expect(again.status).toBe("exists");
    expect(await Bun.file(first.sessionPath).text()).toBe(before);
  });

  it("refuses a conversation with no messages", async () => {
    await expect(
      exportClaudeSession({ ...params(), messages: [] }),
    ).rejects.toThrow("no messages");
  });
});

describe("backupNewestCodexState", () => {
  it("backs up the numerically newest state database with its WAL sidecars", async () => {
    const home = mkdtempSync(join(tmpdir(), "asb-backup-"));
    try {
      writeFileSync(join(home, "state_5.sqlite"), "five");
      writeFileSync(join(home, "state_10.sqlite"), "ten");
      writeFileSync(join(home, "state_10.sqlite-wal"), "wal");
      const result = await backupNewestCodexState(home);
      expect(result?.name).toBe("state_10.sqlite");
      expect(existsSync(result!.backup)).toBe(true);
      expect(existsSync(`${result!.backup}-wal`)).toBe(true);
      expect(existsSync(`${result!.backup}-shm`)).toBe(false);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("returns undefined when the home has no state database", async () => {
    const home = mkdtempSync(join(tmpdir(), "asb-backup-"));
    try {
      expect(await backupNewestCodexState(home)).toBeUndefined();
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
