import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { backfillCodexThreadIndex } from "../src/runtime.js";

const THREAD = "01a20700-eaa3-7000-b1a9-aaaaaaaaaaaa";

const BASE_COLUMNS = `id TEXT PRIMARY KEY, rollout_path TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, source TEXT NOT NULL, model_provider TEXT NOT NULL, cwd TEXT NOT NULL, title TEXT NOT NULL, sandbox_policy TEXT NOT NULL, approval_mode TEXT NOT NULL, tokens_used INTEGER NOT NULL DEFAULT 0, has_user_event INTEGER NOT NULL DEFAULT 0, archived INTEGER NOT NULL DEFAULT 0, cli_version TEXT NOT NULL DEFAULT '', first_user_message TEXT NOT NULL DEFAULT '', memory_mode TEXT NOT NULL DEFAULT 'enabled'`;
const PICKER_COLUMNS = `, preview TEXT NOT NULL DEFAULT '', thread_source TEXT, created_at_ms INTEGER, updated_at_ms INTEGER, recency_at INTEGER, recency_at_ms INTEGER`;

let home: string;
let codexDir: string;

function sql(db: string, statement: string): string {
  return execFileSync("sqlite3", [db, statement], { encoding: "utf8" }).trim();
}

function makeDb(
  name = "state_5.sqlite",
  columns = BASE_COLUMNS + PICKER_COLUMNS,
) {
  const db = join(codexDir, name);
  sql(db, `CREATE TABLE threads (${columns});`);
  return db;
}

function item(timestamp: string, type: string, payload: unknown) {
  return JSON.stringify({ timestamp, type, payload });
}

function writeRollout(
  userText: string | null,
  options: {
    threadId?: string;
    cwd?: string;
    file?: string;
    meta?: boolean;
  } = {},
): string {
  const threadId = options.threadId ?? THREAD;
  const path = join(codexDir, "sessions", options.file ?? "rollout-test.jsonl");
  mkdirSync(join(path, ".."), { recursive: true });
  const lines: string[] = [];
  if (options.meta !== false) {
    lines.push(
      item("2026-11-23T06:00:00.000Z", "session_meta", {
        id: threadId,
        timestamp: "2026-11-23T06:00:00.000Z",
        cwd: options.cwd ?? "/work/demo",
        cli_version: "0.171.0",
        source: "cli",
        model_provider: "openai",
      }),
    );
  }
  if (userText !== null) {
    lines.push(
      item("2026-11-23T06:00:01.000Z", "response_item", {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: userText }],
      }),
    );
  }
  writeFileSync(path, `${lines.join("\n")}\n`);
  return path;
}

function backfill(rolloutPath: string, threadId = THREAD, cwd = "/work/demo") {
  return backfillCodexThreadIndex({
    homeDir: home,
    threadId,
    rolloutPath,
    cwd,
  });
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "codex-backfill-"));
  codexDir = join(home, ".codex");
  mkdirSync(codexDir, { recursive: true });
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

describe("backfillCodexThreadIndex", () => {
  describe("refuses cleanly", () => {
    it("reports missing-db when no state database exists", async () => {
      const result = await backfill(writeRollout("hi"));
      expect(result).toEqual({
        threadId: THREAD,
        indexed: false,
        reason: "missing-db",
      });
    });

    it("reports missing-schema when threads has no id column", async () => {
      sql(join(codexDir, "state_5.sqlite"), "CREATE TABLE threads (x TEXT);");
      const result = await backfill(writeRollout("hi"));
      expect(result.reason).toBe("missing-schema");
    });

    it("reports invalid-thread-id for non-UUIDv7 ids", async () => {
      makeDb();
      for (const bad of ["", "not-a-uuid", "'; DROP TABLE threads; --"]) {
        const result = await backfill(writeRollout("hi"), bad);
        expect(result.reason).toBe("invalid-thread-id");
      }
    });

    it("reports missing-rollout when the file is gone", async () => {
      makeDb();
      const result = await backfill(join(codexDir, "sessions", "nope.jsonl"));
      expect(result.reason).toBe("missing-rollout");
    });

    it("reports missing-session-meta when the rollout has no session_meta", async () => {
      makeDb();
      const result = await backfill(writeRollout("hi", { meta: false }));
      expect(result.reason).toBe("missing-session-meta");
    });
  });

  describe("writes a correct row", () => {
    it("indexes title, preview and first message from the first user turn", async () => {
      const db = makeDb();
      const result = await backfill(writeRollout("Fix the login bug"));
      expect(result.indexed).toBe(true);
      expect(
        sql(
          db,
          "select title, preview, first_user_message, has_user_event from threads;",
        ),
      ).toBe("Fix the login bug|Fix the login bug|Fix the login bug|1");
    });

    it("falls back to a placeholder title when there is no user turn", async () => {
      const db = makeDb();
      await backfill(writeRollout(null));
      expect(sql(db, "select title, has_user_event from threads;")).toBe(
        "Imported session|0",
      );
    });

    it("skips injected bootstrap blocks when choosing the title", async () => {
      const db = makeDb();
      const path = writeRollout(
        "# AGENTS.md instructions\n\n<INSTRUCTIONS>\nx\n</INSTRUCTIONS>",
      );
      appendFileSync(
        path,
        `${item("2026-11-23T06:00:02.000Z", "response_item", {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "The real question" }],
        })}\n`,
      );
      await backfill(path);
      expect(sql(db, "select title from threads;")).toBe("The real question");
    });

    it("works on an older schema without the picker columns", async () => {
      const db = makeDb("state_5.sqlite", BASE_COLUMNS);
      const result = await backfill(writeRollout("old schema"));
      expect(result.indexed).toBe(true);
      expect(sql(db, "select title from threads;")).toBe("old schema");
    });

    it("writes the newest state_N database when several exist", async () => {
      const old = makeDb("state_4.sqlite");
      const next = makeDb("state_6.sqlite");
      await backfill(writeRollout("which db"));
      expect(sql(old, "select count(*) from threads;")).toBe("0");
      expect(sql(next, "select count(*) from threads;")).toBe("1");
    });
  });

  describe("is safe with hostile or unusual text", () => {
    const hostile = [
      "it's a quote",
      `say "hi"; DROP TABLE threads; --`,
      "'); DELETE FROM threads; --",
      "line one\nline two\n\nline four",
      "unicode: héllo 日本語 🚀",
      "percent %s and backslash \\ and ?",
    ];

    for (const text of hostile) {
      it(`round-trips ${JSON.stringify(text.slice(0, 24))}`, async () => {
        const db = makeDb();
        const result = await backfill(writeRollout(text));
        expect(result.indexed).toBe(true);
        expect(sql(db, "select count(*) from threads;")).toBe("1");
        expect(sql(db, "select preview from threads;")).toBe(text.trim());
      });
    }

    it("handles apostrophes in cwd and rollout path", async () => {
      const db = makeDb();
      const cwd = "/work/it's/mine";
      const path = writeRollout("hi", { cwd, file: "o'brien/rollout-x.jsonl" });
      const result = await backfill(path, THREAD, cwd);
      expect(result.indexed).toBe(true);
      expect(sql(db, "select cwd from threads;")).toBe(cwd);
      expect(sql(db, "select rollout_path from threads;")).toBe(path);
    });

    it("indexes a very large first message (over the argv limit)", async () => {
      const db = makeDb();
      const big = `${"x".repeat(300_000)}`;
      const result = await backfill(writeRollout(big));
      expect(result.indexed).toBe(true);
      expect(sql(db, "select length(preview) from threads;")).toBe("300000");
    });
  });

  describe("is idempotent", () => {
    it("updates the same row instead of duplicating", async () => {
      const db = makeDb();
      const path = writeRollout("first");
      await backfill(path);
      await backfill(path);
      expect(sql(db, "select count(*) from threads;")).toBe("1");
    });

    it("refreshes updated_at when the rollout grows", async () => {
      const db = makeDb();
      const path = writeRollout("first");
      await backfill(path);
      const before = Number(sql(db, "select updated_at from threads;"));
      appendFileSync(
        path,
        `${item("2026-11-23T09:00:00.000Z", "response_item", {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "later reply" }],
        })}\n`,
      );
      await backfill(path);
      const after = Number(sql(db, "select updated_at from threads;"));
      expect(after).toBeGreaterThan(before);
      expect(sql(db, "select count(*) from threads;")).toBe("1");
    });

    it("keeps separate rows for separate threads", async () => {
      const db = makeDb();
      const other = "01a20700-eaa3-7000-b1a9-bbbbbbbbbbbb";
      await backfill(writeRollout("one"));
      await backfill(
        writeRollout("two", { threadId: other, file: "rollout-two.jsonl" }),
        other,
      );
      expect(sql(db, "select count(*) from threads;")).toBe("2");
    });
  });
});
