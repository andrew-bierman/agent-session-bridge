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
  resumeArgs,
  runCodex,
  threadRows,
  type CodexSandbox,
  type RolloutLine,
} from "./support/codex.js";
import {
  FINAL,
  PROMPT,
  TOOL_OUTPUT,
  echoConversation,
} from "./support/conversation.js";
import { describeInContainer, saveArtifacts } from "./support/in-container.js";
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

interface HistoryMessage {
  role: string;
  content?: unknown;
  tool_call_id?: string;
  tool_calls?: { id: string; function?: { name?: string } }[];
}

/**
 * The conversation history a journaled request carried. aimock journals every
 * wire, including Codex's WebSocket turns, in its normalized chat form.
 */
function historyOf(body: unknown): HistoryMessage[] {
  const messages = (body as { messages?: unknown } | null)?.messages;
  return Array.isArray(messages) ? (messages as HistoryMessage[]) : [];
}

const textOf = (message: HistoryMessage) =>
  JSON.stringify(message.content ?? "");

/** A fresh Codex whose thread database exists, as a real user's does. */
async function warmSandbox(label: string): Promise<CodexSandbox> {
  const sandbox = createCodexSandbox(mock.openaiBaseUrl);
  mock.reply(label, `${label} ok`);
  const run = await runCodex(sandbox, execArgs(sandbox.project, label));
  expect(run.code).toBe(0);
  return sandbox;
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

    // Same paired, top-level call and output as the real run, with string arguments.
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

    // No tool call is smuggled inside a message: real Codex never writes that.
    for (const line of exported.filter(
      (l) => kind(l) === "response_item:message",
    )) {
      const content = line.payload.content as { type: string }[];
      expect(content.every((c) => c.type.endsWith("_text"))).toBe(true);
    }

    // Per record kind, the exporter carries the keys Codex needs to load a session.
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
    const sandbox = await warmSandbox("warm-up resume");
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
    const resumed = await runCodex(
      sandbox,
      resumeArgs(THREAD, "follow-up question"),
    );
    if (resumed.code !== 0) console.error(resumed.stdout, resumed.stderr);
    expect(resumed.code).toBe(0);
    expect(resumed.stdout).toContain("Follow-up answer.");
    expect(mock.unmatchedSummary()).toEqual([]);

    const [request] = mock.requestsContaining("follow-up question");
    const history = historyOf(request!.body);
    const user = history.findIndex(
      (m) => m.role === "user" && textOf(m).includes(PROMPT),
    );
    const call = history.findIndex((m) =>
      m.tool_calls?.some(
        (c) =>
          c.id === "call_exported_1" && c.function?.name === "exec_command",
      ),
    );
    const output = history.findIndex(
      (m) =>
        m.role === "tool" &&
        m.tool_call_id === "call_exported_1" &&
        textOf(m).includes("hello-from-codex"),
    );
    const final = history.findIndex(
      (m) => m.role === "assistant" && textOf(m).includes(FINAL),
    );
    const followUp = history.findIndex(
      (m) => m.role === "user" && textOf(m).includes("follow-up question"),
    );
    // Every exported message reached the model, in order, ahead of the new turn.
    for (const index of [user, call, output, final, followUp]) {
      expect(index).toBeGreaterThanOrEqual(0);
    }
    expect([user, call, output, final, followUp]).toEqual(
      [user, call, output, final, followUp].sort((a, b) => a - b),
    );
    saveArtifacts("codex-resumed", sandbox.codexHome);
  }, 240_000);

  it("indexes and resumes a session whose first message is 300KB", async () => {
    const sandbox = await warmSandbox("warm-up big");
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
    const resumed = await runCodex(
      sandbox,
      resumeArgs(BIG_THREAD, "big follow-up"),
    );
    expect(resumed.code).toBe(0);
    expect(resumed.stdout).toContain("Big follow-up answer.");
  }, 240_000);

  it("re-exporting leaves one thread row and an unchanged rollout", async () => {
    const sandbox = await warmSandbox("warm-up idempotent");
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
