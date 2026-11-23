import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
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
  "rejects %s tool history explicitly instead of importing a partial transcript",
  async (tool, name) => {
    await expect(
      createOpenCodeSeed(tool, fixturePath(name), "/repo/demo"),
    ).rejects.toThrow("text-only source conversation");
  },
);

it.runIf(process.env.TEST_OPENCODE === "1").each(fixtures)(
  "natively imports %s once and rejects edits to the already imported history",
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
    writeFileSync(
      path,
      readFileSync(path, "utf8").replace("Fix auth", "Edited prompt"),
    );
    expect(seed).toThrow("OpenCode mirror differs from the source");
    expect(exported()).toEqual(first);
  },
  60000,
);
