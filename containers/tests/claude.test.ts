import { afterAll, beforeAll, expect, it } from "bun:test";

import {
  exportClaudeSession,
  omnigentCodexThreadId,
} from "../../packages/core/src/index.js";
import {
  blocksOf,
  createClaudeSandbox,
  findSessions,
  printArgs,
  readSession,
  resumeArgs,
  runClaude,
  type ClaudeSandbox,
  type SessionLine,
} from "./support/claude.js";
import {
  FINAL,
  PROMPT,
  TOOL_OUTPUT,
  echoConversation,
} from "./support/conversation.js";
import { historyOf, locateHistory } from "./support/history.js";
import { describeInContainer, saveArtifacts } from "./support/in-container.js";
import { ScriptedMock } from "./support/mock.js";

const SESSION = omnigentCodexThreadId("0123456789abcdef0123456789abcdef");

let mock: ScriptedMock;
let real: ClaudeSandbox;

const kinds = (lines: SessionLine[]) => new Set(lines.map((l) => l.type));

function keysByType(lines: SessionLine[]): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const line of lines) {
    const set = out.get(line.type) ?? new Set<string>();
    for (const key of Object.keys(line)) set.add(key);
    out.set(line.type, set);
  }
  return out;
}

describeInContainer("real Claude Code against the mock", () => {
  beforeAll(async () => {
    mock = await ScriptedMock.start();
    mock.toolRound(
      PROMPT,
      {
        id: "toolu_claude_echo",
        name: "Bash",
        args: {
          command: "echo hello-from-codex",
          description: "Print a greeting",
        },
      },
      FINAL,
    );
    real = createClaudeSandbox(mock.anthropicBaseUrl);
  });
  afterAll(async () => {
    saveArtifacts("claude-real", real.configDir);
    await mock.stop();
  });

  it("runs a scripted tool-use turn and writes a session transcript", async () => {
    const result = await runClaude(real, printArgs(PROMPT));
    if (result.code !== 0) console.error(result.stdout, result.stderr);
    expect(result.code).toBe(0);
    expect(mock.requestsOn("messages").length).toBeGreaterThanOrEqual(2);
    expect(mock.unmatchedSummary()).toEqual([]);

    const sessions = findSessions(real.configDir);
    expect(sessions).toHaveLength(1);
    const lines = readSession(sessions[0]!);
    const blocks = lines.flatMap(blocksOf);
    const use = blocks.find((b) => b.type === "tool_use");
    expect(use).toMatchObject({ id: "toolu_claude_echo", name: "Bash" });
    const result_ = blocks.find((b) => b.type === "tool_result");
    expect(result_).toMatchObject({ tool_use_id: "toolu_claude_echo" });
    expect(JSON.stringify(lines)).toContain("hello-from-codex");
    expect(JSON.stringify(lines)).toContain(FINAL);
  }, 180_000);

  it("exports the same conversation with the line types and keys real Claude Code writes", () => {
    const realLines = readSession(findSessions(real.configDir)[0]!);
    const messages = echoConversation({ callId: "toolu_exported_1" });
    const scratch = createClaudeSandbox(mock.anthropicBaseUrl);
    return exportClaudeSession({
      messages,
      cwd: scratch.project,
      sessionId: SESSION,
      homeDir: scratch.homeDir,
    }).then(() => {
      const exported = readSession(findSessions(scratch.configDir)[0]!);
      expect(exported).toHaveLength(4);

      const realKinds = kinds(realLines);
      for (const type of kinds(exported))
        expect(realKinds.has(type)).toBe(true);

      const required = [
        "uuid",
        "parentUuid",
        "sessionId",
        "cwd",
        "timestamp",
        "message",
      ];
      const realKeys = keysByType(realLines);
      const exportedKeys = keysByType(exported);
      for (const type of ["user", "assistant"]) {
        for (const key of required) {
          expect(realKeys.get(type)?.has(key)).toBe(true);
          expect(exportedKeys.get(type)?.has(key)).toBe(true);
        }
      }

      const [first, second, third] = exported;
      expect(first!.parentUuid).toBeNull();
      expect(second!.parentUuid).toBe(first!.uuid);
      expect(third!.parentUuid).toBe(second!.uuid);
      expect(blocksOf(second!)[0]).toMatchObject({
        type: "tool_use",
        name: "exec_command",
      });
      expect(blocksOf(third!)[0]).toMatchObject({ type: "tool_result" });
      expect(JSON.stringify(blocksOf(third!))).toContain(TOOL_OUTPUT.trim());
    });
  });

  it("resumes an exported session and replays its history, tool call included, to the model", async () => {
    const sandbox = createClaudeSandbox(mock.anthropicBaseUrl);
    const messages = echoConversation({ callId: "toolu_exported_2" });
    const exported = await exportClaudeSession({
      messages,
      cwd: sandbox.project,
      sessionId: SESSION,
      homeDir: sandbox.homeDir,
    });
    expect(exported.status).toBe("exported");

    mock.reply("follow-up question", "Follow-up answer.");
    mock.clearRequests();
    const resumed = await runClaude(
      sandbox,
      resumeArgs(SESSION, "follow-up question"),
    );
    if (resumed.code !== 0) console.error(resumed.stdout, resumed.stderr);
    expect(resumed.code).toBe(0);
    expect(resumed.stdout).toContain("Follow-up answer.");
    expect(mock.unmatchedSummary()).toEqual([]);

    const [request] = mock.requestsContaining("follow-up question");
    const positions = locateHistory(historyOf(request!.body), {
      prompt: PROMPT,
      callId: "toolu_exported_2",
      toolName: "exec_command",
      toolOutput: "hello-from-codex",
      final: FINAL,
      followUp: "follow-up question",
    });
    for (const index of positions) expect(index).toBeGreaterThanOrEqual(0);
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
    saveArtifacts("claude-resumed", sandbox.configDir);
  }, 240_000);

  it("fails visibly when asked to resume a session id that does not exist", async () => {
    const sandbox = createClaudeSandbox(mock.anthropicBaseUrl);
    const result = await runClaude(
      sandbox,
      resumeArgs("00000000-0000-4000-8000-000000000000", "anything"),
    );
    expect(result.code).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toMatch(
      /no conversation found|not found/i,
    );
  }, 120_000);
});
