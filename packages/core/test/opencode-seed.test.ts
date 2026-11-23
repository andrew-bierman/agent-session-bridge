import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import {
  appendOpenCodeMessages,
  readOpenCodeRows,
} from "../src/opencode-store.js";
import { createOpenCodeSeed } from "../src/runtime.js";

const fixtures = [
  ["codex", "codex-rollout.jsonl"],
  ["claude", "claude-session.jsonl"],
  ["pi", "pi-session.jsonl"],
] as const;

let root: string;
afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});

function fixturePath(name: string) {
  return fileURLToPath(new URL("fixtures/" + name, import.meta.url));
}

function textTranscript(tool: (typeof fixtures)[number][0], name: string) {
  const lines = readFileSync(fixturePath(name), "utf8").trim().split("\n");
  const records = lines
    .slice(0, tool === "claude" ? 2 : 3)
    .map((line) => JSON.parse(line));
  if (tool === "codex")
    records[0].payload.id = "019cdef0-2584-7a14-8020-123456789abc";
  const assistant = records.at(-1);
  const payload = tool === "codex" ? assistant.payload : assistant.message;
  payload.content = payload.content.slice(0, 1);
  const path = join(root, name);
  writeFileSync(
    path,
    records.map((record) => JSON.stringify(record)).join("\n") + "\n",
  );
  return path;
}

const expectedTurns = [
  ["user", "Fix auth", Date.parse("2026-04-05T10:00:01.000Z")],
  ["assistant", "Looking.", Date.parse("2026-04-05T10:00:02.000Z")],
];

it.each(fixtures)(
  "preserves %s roles, text, timestamps, and stable native IDs",
  async (tool, name) => {
    root = mkdtempSync(join(tmpdir(), "bridge-seed-"));
    const path = textTranscript(tool, name);
    const bundle = await createOpenCodeSeed(tool, path, root);
    expect(bundle.info.location.directory).toBe(root);
    expect(bundle.info.id).toMatch(/^ses_[a-zA-Z0-9]+$/);
    expect(
      bundle.messages.map((message) => [
        message.type,
        message.type === "user" ? message.text : message.content[0]?.text,
        message.time.created,
      ]),
    ).toEqual(expectedTurns);
    expect(new Set(bundle.messages.map((message) => message.id)).size).toBe(2);
    expect(await createOpenCodeSeed(tool, path, root)).toEqual(bundle);
  },
);

it.each(fixtures)(
  "preserves settled %s tool calls and results as inert text",
  async (tool, name) => {
    const bundle = await createOpenCodeSeed(
      tool,
      fixturePath(name),
      "/repo/demo",
    );
    const assistant = bundle.messages.filter(
      (message) => message.type === "assistant",
    );
    expect(
      assistant
        .flatMap((message) => message.content)
        .every((block) => block.type === "text"),
    ).toBe(true);
    const history = assistant
      .flatMap((message) => message.content)
      .map((block) => block.text);
    expect(history).toContain("Looking.");
    expect(
      history.some(
        (text) =>
          text.startsWith("Historical tool record") &&
          text.includes('"type":"tool_call"') &&
          text.includes("auth.ts"),
      ),
    ).toBe(true);
    expect(
      history.some(
        (text) =>
          text.startsWith("Historical tool record") &&
          text.includes('"type":"tool_result"') &&
          text.includes("file contents"),
      ),
    ).toBe(true);
  },
);

it.each(fixtures)(
  "rejects a %s seed with an unsettled tool call",
  async (tool, name) => {
    root = mkdtempSync(join(tmpdir(), "bridge-seed-unsettled-"));
    const path = join(root, name);
    const lines = readFileSync(fixturePath(name), "utf8").trim().split("\n");
    writeFileSync(path, lines.slice(0, -1).join("\n") + "\n");
    await expect(createOpenCodeSeed(tool, path, root)).rejects.toThrow(
      "Unsettled tool calls",
    );
  },
);

it.runIf(process.env.TEST_OPENCODE === "1").each(fixtures)(
  "seeds and syncs %s under its original ID without duplicating history",
  (tool, name) => {
    root = mkdtempSync(join(tmpdir(), "bridge-native-seed-"));
    const path = textTranscript(tool, name);
    const database = join(root, "opencode.db");
    const options = {
      cwd: root,
      encoding: "utf8" as const,
      timeout: 15000,
      env: {
        PATH: process.env.PATH,
        HOME: root,
        OPENCODE_DB: database,
        OPENCODE_DISABLE_AUTOUPDATE: "true",
        XDG_DATA_HOME: join(root, "data"),
        XDG_CONFIG_HOME: join(root, "config"),
        XDG_STATE_HOME: join(root, "state"),
        XDG_CACHE_HOME: join(root, "cache"),
      },
    };
    const bridge = fileURLToPath(
      new URL("../../../bin/agent-session-bridge", import.meta.url),
    );
    const run = (bin: string, ...args: string[]) =>
      execFileSync(bin, args, { ...options, stdio: "pipe" });
    new DatabaseSync(database).close();
    const seed = () => run(bridge, "seed-opencode", tool, path, database);
    const result = seed();
    const id = result.match(
      /OpenCode (ses_[a-zA-Z0-9]+): verified 2 seeded messages/,
    )?.[1];
    expect(id).toBeDefined();
    const exported = () =>
      JSON.parse(run("opencode", "session", "export", "--standalone", id!));
    const first = exported();
    expect(
      first.messages.map(
        (message: {
          type: string;
          text?: string;
          content?: { text: string }[];
          time: { created: number };
        }) => [
          message.type,
          message.text ?? message.content?.[0]?.text,
          message.time.created,
        ],
      ),
    ).toEqual(expectedTurns);
    expect(seed()).toBe(result);
    expect(exported()).toEqual(first);
    const original = readFileSync(path, "utf8");
    writeFileSync(path, original.replace("Fix auth", "Edited prompt"));
    expect(seed).toThrow("OpenCode mirror differs from the source");
    expect(exported()).toEqual(first);
    writeFileSync(path, original);
    const firstRecord = JSON.parse(original.split("\n")[0]!);
    const nativeId =
      firstRecord.payload?.id ?? firstRecord.sessionId ?? firstRecord.id;
    const rich = join(root, "tool-history.jsonl");
    writeFileSync(
      rich,
      readFileSync(fixturePath(name), "utf8")
        .replaceAll("codex-session-1", "019cdef0-2584-7a14-8020-fedcba987654")
        .replaceAll("claude-session-1", "rich-claude-session")
        .replaceAll("pi-session-1", "rich-pi-session"),
    );
    const importedRich = run(bridge, "seed-opencode", tool, rich, database);
    const richId = importedRich.match(
      /OpenCode (ses_[a-zA-Z0-9]+): verified 3 seeded messages/,
    )?.[1];
    expect(richId).toBeDefined();
    const richExport = JSON.parse(
      run("opencode", "session", "export", "--standalone", richId!),
    );
    expect(
      richExport.messages.map((message: { type: string }) => message.type),
    ).toEqual(["user", "assistant", "assistant"]);
    expect(richExport.messages.at(-1)?.content).toEqual([
      { type: "text", text: expect.stringContaining("file contents") },
    ]);
    const sync = () => run(bridge, "sync-opencode", id!, database);
    const version = run("opencode", "--version")
      .trim()
      .replace(/^opencode v/, "");
    const { rows, cursor } = readOpenCodeRows(database, version, id!);
    const created = Date.parse("2026-04-05T10:00:03.000Z");
    appendOpenCodeMessages(database, version, id!, rows, [
      {
        id: "msg_0000000000000000000000000000009",
        type: "user",
        seq: cursor + 1,
        time_created: created,
        time_updated: created,
        data: JSON.stringify({
          time: { created },
          text: "New OpenCode prompt",
        }),
      },
    ]);
    expect(sync()).toContain(`${nativeId}:`);
    expect(sync()).toContain("0 records appended");
    const synced = readFileSync(path, "utf8");
    expect(synced.match(/New OpenCode prompt/g)).toHaveLength(
      tool === "codex" ? 2 : 1,
    );
    expect(synced.match(/Fix auth/g)).toHaveLength(1);
    const timestamp = "2026-04-05T10:00:04.000Z";
    const reply = "New original-harness answer";
    const nativeRecord =
      tool === "codex"
        ? {
            type: "response_item",
            timestamp,
            payload: {
              type: "message",
              role: "assistant",
              content: [{ type: "output_text", text: reply }],
            },
          }
        : tool === "claude"
          ? {
              type: "assistant",
              timestamp,
              uuid: "native-reply",
              sessionId: nativeId,
              message: {
                role: "assistant",
                content: [{ type: "text", text: reply }],
              },
            }
          : {
              type: "message",
              timestamp,
              id: "12345678",
              message: {
                role: "assistant",
                content: [{ type: "text", text: reply }],
              },
            };
    writeFileSync(path, synced + JSON.stringify(nativeRecord) + "\n");
    expect(sync()).toContain("1 messages appended");
    expect(sync()).toContain("0 messages appended");
    expect(exported().messages.at(-1)?.content).toEqual([
      { type: "text", text: reply },
    ]);
    expect(
      readFileSync(path, "utf8").match(/New original-harness answer/g),
    ).toHaveLength(1);
  },
  60000,
);
