import { afterAll, beforeAll, expect, it } from "bun:test";

import {
  convertConversationToCodexRollout,
  exportCodexSession,
  type NormalizedMessage,
} from "../../packages/core/src/index.js";
import {
  createCodexSandbox,
  execArgs,
  findRollouts,
  readRollout,
  resumeInTui,
  runCodex,
  threadRows,
  type CodexSandbox,
  type RolloutLine,
  warmCodexSandbox,
} from "./support/codex.js";
import {
  FINAL,
  PROMPT,
  TOOL_OUTPUT,
  echoConversation,
} from "./support/conversation.js";
import { describeInContainer, saveArtifacts } from "./support/in-container.js";
import { locateHistory } from "./support/history.js";
import { ScriptedMock } from "./support/mock.js";

const THREAD = "01a20bd7-c82b-7000-b619-d10335d3ce3e";
const BIG_THREAD = "01a20bd7-c82b-7000-b619-d10335d3ce3f";

let mock: ScriptedMock;
let real: CodexSandbox;

const kind = (line: RolloutLine) =>
  `${line.type}${line.payload.type ? `:${line.payload.type}` : ""}`;

function keysByKind(lines: RolloutLine[]): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const line of lines) {
    const set = out.get(kind(line)) ?? new Set<string>();
    for (const key of Object.keys(line.payload)) set.add(key);
    out.set(kind(line), set);
  }
  return out;
}

describeInContainer("real Codex against the mock", () => {
  beforeAll(async () => {
    mock = await ScriptedMock.start();
    mock.toolRound(
      PROMPT,
      {
        id: "call_codex_echo",
        name: "exec_command",
        args: { cmd: "echo hello-from-codex" },
      },
      FINAL,
    );
    real = createCodexSandbox(mock.openaiBaseUrl);
  });
  afterAll(async () => {
    saveArtifacts("codex-real", real.codexHome);
    await mock.stop();
  });

  it("runs a scripted tool-call turn and writes a rollout and a thread row", async () => {
    const result = await runCodex(real, execArgs(real.project, PROMPT));
    expect(result.code).toBe(0);
    expect(mock.requestsOn("responses").length).toBeGreaterThanOrEqual(2);
    expect(mock.unmatchedSummary()).toEqual([]);

    const rollouts = findRollouts(real.codexHome);
    expect(rollouts).toHaveLength(1);
    const lines = readRollout(rollouts[0]!);
    expect(lines[0]!.type).toBe("session_meta");
    expect(JSON.stringify(lines)).toContain("hello-from-codex");
    expect(JSON.stringify(lines)).toContain(FINAL);

    const threads = threadRows(real.codexHome);
    expect(threads).toHaveLength(1);
    expect(threads[0]!.preview).toBe(PROMPT);
  }, 180_000);

  it("writes the call and its output as paired top-level records, in that order", () => {
    const lines = readRollout(findRollouts(real.codexHome)[0]!);
    const calls = lines.filter(
      (l) => kind(l) === "response_item:function_call",
    );
    const outputs = lines.filter(
      (l) => kind(l) === "response_item:function_call_output",
    );
    expect(calls).toHaveLength(1);
    expect(outputs).toHaveLength(1);
    expect(calls[0]!.payload.call_id).toBe(outputs[0]!.payload.call_id);
    expect(typeof calls[0]!.payload.arguments).toBe("string");
    expect(lines.indexOf(calls[0]!)).toBeLessThan(lines.indexOf(outputs[0]!));
  });

  it("exports the same conversation with a call record for every output, as real Codex writes it", () => {
    const messages = echoConversation({ callId: "call_exported_1" });
    const exported = convertConversationToCodexRollout(
      messages,
      "/work/demo",
      THREAD,
    ) as RolloutLine[];
    const realLines = readRollout(findRollouts(real.codexHome)[0]!);

    // Every record kind the exporter writes is one real Codex also writes, except
    // two legacy event kinds Codex 0.172 no longer emits but still loads (the
    // resume test below proves it accepts them).
    const legacyEvents = new Set([
      "event_msg:user_message",
      "event_msg:agent_message",
    ]);
    const realKinds = new Set(realLines.map(kind));
    for (const line of exported) {
      expect(realKinds.has(kind(line)) || legacyEvents.has(kind(line))).toBe(
        true,
      );
    }

    const calls = exported.filter(
      (l) => kind(l) === "response_item:function_call",
    );
    const outputs = exported.filter(
      (l) => kind(l) === "response_item:function_call_output",
    );
    expect(calls).toHaveLength(1);
    expect(outputs).toHaveLength(1);
    expect(calls[0]!.payload.call_id).toBe("call_exported_1");
    expect(calls[0]!.payload.name).toBe("exec_command");
    expect(JSON.parse(calls[0]!.payload.arguments as string)).toEqual({
      cmd: "echo hello-from-codex",
    });
    expect(outputs[0]!.payload.call_id).toBe("call_exported_1");
    expect(exported.indexOf(calls[0]!)).toBeLessThan(
      exported.indexOf(outputs[0]!),
    );

    for (const line of exported.filter(
      (l) => kind(l) === "response_item:message",
    )) {
      const content = line.payload.content as { type: string }[];
      expect(content.every((c) => c.type.endsWith("_text"))).toBe(true);
    }

    const exportedKeys = keysByKind(exported);
    const realKeys = keysByKind(realLines);
    const required: Record<string, string[]> = {
      session_meta: [
        "id",
        "cwd",
        "timestamp",
        "cli_version",
        "originator",
        "source",
      ],
      turn_context: [
        "turn_id",
        "cwd",
        "model",
        "approval_policy",
        "sandbox_policy",
      ],
      "response_item:message": ["role", "content", "type"],
      "response_item:function_call": ["call_id", "name", "arguments", "type"],
      "response_item:function_call_output": ["call_id", "output", "type"],
    };
    for (const [recordKind, keys] of Object.entries(required)) {
      for (const key of keys) {
        expect(realKeys.get(recordKind)?.has(key)).toBe(true); // real writes it
        expect(exportedKeys.get(recordKind)?.has(key)).toBe(true); // so do we
      }
    }
  });

  it("resumes an exported session and replays its history, tool call included, to the model", async () => {
    const sandbox = await warmCodexSandbox(mock, "warm-up resume");
    const messages = echoConversation({ callId: "call_exported_1" });
    const result = await exportCodexSession({
      messages,
      cwd: sandbox.project,
      sessionId: THREAD,
      codexHome: sandbox.codexHome,
      homeDir: sandbox.homeDir,
    });
    expect(result.status).toBe("exported");
    expect(result.indexed?.indexed).toBe(true);

    const row = threadRows(sandbox.codexHome).find((r) => r.id === THREAD);
    expect(row?.preview).toBe(PROMPT);
    expect(row?.cwd).toBe(sandbox.project);
    expect(row?.archived).toBe(0);

    mock.reply("follow-up question", "Follow-up answer.");
    mock.clearRequests();
    const resumed = await resumeInTui(
      sandbox,
      mock,
      THREAD,
      "follow-up question",
    );
    expect(resumed.reached).toBe(true);
    expect(resumed.screen).toContain("Follow-up answer.");
    expect(mock.unmatchedSummary()).toEqual([]);

    const positions = locateHistory(
      mock.historyForUserText("follow-up question")!,
      {
        prompt: PROMPT,
        callId: "call_exported_1",
        toolName: "exec_command",
        toolOutput: "hello-from-codex",
        final: FINAL,
        followUp: "follow-up question",
      },
    );
    for (const index of positions) expect(index).toBeGreaterThanOrEqual(0);
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
    saveArtifacts("codex-resumed", sandbox.codexHome);
  }, 240_000);

  it("indexes and resumes a session whose first message is 300KB", async () => {
    const sandbox = await warmCodexSandbox(mock, "warm-up big");
    const marker = "BIGSTART";
    const prompt = `${marker} ${"x".repeat(300_000)} BIGEND`;
    const messages: NormalizedMessage[] = echoConversation({
      callId: "call_big_1",
      start: "2026-11-24T02:00:00.000Z",
      prompt,
    });
    const result = await exportCodexSession({
      messages,
      cwd: sandbox.project,
      sessionId: BIG_THREAD,
      codexHome: sandbox.codexHome,
      homeDir: sandbox.homeDir,
    });
    expect(result.indexed?.indexed).toBe(true);
    const row = threadRows(sandbox.codexHome, "id, preview").find(
      (r) => r.id === BIG_THREAD,
    );
    expect(String(row?.preview)).toContain(marker);

    mock.reply("big follow-up", "Big follow-up answer.");
    const resumed = await resumeInTui(
      sandbox,
      mock,
      BIG_THREAD,
      "big follow-up",
    );
    expect(resumed.reached).toBe(true);
    expect(resumed.screen).toContain("Big follow-up answer.");
    const rollout = await Bun.file(result.rolloutPath).text();
    expect(rollout).toContain(marker);
    expect(rollout).toContain("BIGEND");

    // aimock journals a body this large only as its original size, so that size
    // proves Codex sent the whole message on resume rather than cutting it.
    const sent = mock
      .requests()
      .map((entry) => entry.body as { originalByteSize?: number } | null)
      .filter((body) => body && "__aimock_truncated" in body)
      .map((body) => body!.originalByteSize ?? 0);
    expect(Math.max(0, ...sent)).toBeGreaterThan(300_000);
  }, 240_000);

  it("re-exporting leaves one thread row and an unchanged rollout", async () => {
    const sandbox = await warmCodexSandbox(mock, "warm-up idempotent");
    const params = {
      messages: echoConversation({ callId: "call_idem_1" }),
      cwd: sandbox.project,
      sessionId: "01a20bd7-c82b-7000-b619-d10335d3ce40",
      codexHome: sandbox.codexHome,
      homeDir: sandbox.homeDir,
    };
    const first = await exportCodexSession(params);
    const before = await Bun.file(first.rolloutPath).text();
    const second = await exportCodexSession(params);
    expect(second.status).toBe("exists");
    expect(await Bun.file(first.rolloutPath).text()).toBe(before);
    expect(
      threadRows(sandbox.codexHome).filter((r) => r.id === params.sessionId),
    ).toHaveLength(1);
    expect(before).toContain(TOOL_OUTPUT.trim());
  }, 180_000);
});
