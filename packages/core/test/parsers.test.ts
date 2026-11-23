import { join } from "node:path";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { zstdCompressSync } from "node:zlib";
import { describe, expect, it } from "vitest";

import {
  extractMessageEntries,
  flattenPiActiveBranch,
  iterateCodexRollout,
  readClaudeCodeSession,
  readCodexRollout,
  readPiSession,
} from "../src/index.js";

const fixturesDir = join(import.meta.dirname, "fixtures");

describe("session parsers", () => {
  it("reads a Pi session and flattens the active branch", async () => {
    const session = await readPiSession(join(fixturesDir, "pi-session.jsonl"));

    expect(session.header.cwd).toBe("/repo/demo");
    expect(flattenPiActiveBranch(session).map((entry) => entry.id)).toEqual([
      "aaaa1111",
      "bbbb2222",
      "cccc3333",
    ]);
    expect(extractMessageEntries(session.entries)).toHaveLength(3);
  });

  it("reads a Claude Code session", async () => {
    const lines = await readClaudeCodeSession(
      join(fixturesDir, "claude-session.jsonl"),
    );
    expect(lines).toHaveLength(3);
    expect(lines[1]?.type).toBe("assistant");
  });

  it("tolerates unknown JSONL line types without failing the whole parse", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "asb-unknown-"));
    const unknownPath = join(tempDir, "unknown-claude.jsonl");
    await writeFile(
      unknownPath,
      `${JSON.stringify({ type: "mystery", value: true })}\n${JSON.stringify({
        type: "assistant",
        uuid: "known",
      })}\n`,
    );

    const lines = await readClaudeCodeSession(unknownPath);
    expect(lines.map((line) => line.type)).toEqual(["mystery", "assistant"]);
  });

  it("reads plain and compressed Codex rollouts", async () => {
    const rolloutPath = join(fixturesDir, "codex-rollout.jsonl");
    const rollout = await readCodexRollout(rolloutPath);
    expect(rollout).toHaveLength(4);

    const raw = await readFile(rolloutPath);
    const tempDir = await mkdtemp(join(tmpdir(), "asb-zstd-"));
    const compressedPath = join(tempDir, "codex-rollout.jsonl.zst");
    await writeFile(compressedPath, zstdCompressSync(raw));

    const compressed = await readCodexRollout(compressedPath);
    expect(compressed).toHaveLength(4);
    expect(compressed[0]?.type).toBe("session_meta");
  });
  it("reports missing and malformed streamed Codex rollouts", async () => {
    const dir = await mkdtemp(join(tmpdir(), "asb-stream-errors-"));
    const path = join(dir, "rollout.jsonl");
    await expect(readCodexRollout(path)).rejects.toMatchObject({
      code: "ENOENT",
    });
    await writeFile(path, '{"type":"event_msg"}\r\n\r\ninvalid JSON');
    await expect(readCodexRollout(path)).rejects.toThrow(SyntaxError);
    const compressed = path + ".zst";
    await writeFile(compressed, "invalid compressed data");
    await expect(readCodexRollout(compressed)).rejects.toThrow();
  });
  it("can abandon a compressed rollout without an unhandled stream error", async () => {
    const path = join(
      await mkdtemp(join(tmpdir(), "asb-zstd-stop-")),
      "rollout.zst",
    );
    const record = '{"type":"event_msg"}\n';
    await writeFile(path, zstdCompressSync(record.repeat(100_000)));
    const iterator = iterateCodexRollout(path);
    expect((await iterator.next()).value).toEqual({ type: "event_msg" });
    await expect(iterator.return(undefined)).resolves.toMatchObject({
      done: true,
    });
    await writeFile(
      path,
      zstdCompressSync(record + "invalid JSON\n" + record.repeat(100_000)),
    );
    await expect(readCodexRollout(path)).rejects.toThrow(SyntaxError);
  });
});
