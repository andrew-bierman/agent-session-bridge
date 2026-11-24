import { afterAll, beforeAll, expect, it } from "bun:test";

import {
  listOmnigentCodexSessions,
  listOmnigentConversations,
  omnigentBridgeHash,
  type OmnigentConversationInfo,
  type OmnigentSession,
} from "../../packages/core/src/index.js";
import {
  CODEX_MODEL,
  createCodexSandbox,
  execArgs,
  findRollouts,
  readRollout,
  resumeInTui,
  runCodex,
  threadRows,
  type CodexSandbox,
} from "./support/codex.js";
import { FINAL, PROMPT } from "./support/conversation.js";
import { locateHistory } from "./support/history.js";
import { describeInContainer, saveArtifacts } from "./support/in-container.js";
import { ScriptedMock } from "./support/mock.js";
import {
  createOmnigentSandbox,
  filesContaining,
  installUserCodexHome,
  runCodexSync,
  screen,
  startOmnigent,
  stopTerminal,
  waitFor,
  type OmnigentSandbox,
} from "./support/omnigent.js";

let mock: ScriptedMock;
let omni: OmnigentSandbox;
let conversation: OmnigentConversationInfo;
let session: OmnigentSession;

/** A Codex whose thread database exists, as a real user's does. */
async function warmCodex(label: string): Promise<CodexSandbox> {
  const sandbox = createCodexSandbox(mock.openaiBaseUrl);
  mock.script([
    { match: { userMessage: label }, response: { content: `${label} ok` } },
  ]);
  expect((await runCodex(sandbox, execArgs(sandbox.project, label))).code).toBe(
    0,
  );
  return sandbox;
}

describeInContainer("Omnigent native Codex bridge, locator, and sync", () => {
  beforeAll(async () => {
    mock = await ScriptedMock.start();
    mock.script([
      {
        match: { systemMessage: "naming a coding session" },
        response: { content: "Echo greeting" },
      },
      {
        match: { systemMessage: "concise 2-5 word title" },
        response: { content: "Echo greeting" },
      },
      {
        match: { userMessage: "<user_message>", model: "gpt-5.6-luna" },
        response: { content: "Echo greeting" },
      },
    ]);
    mock.toolRound(
      PROMPT,
      {
        id: "call_bridge_echo",
        name: "exec_command",
        args: { cmd: "echo hello-from-codex" },
      },
      FINAL,
    );
    omni = createOmnigentSandbox({
      openaiBaseUrl: mock.openaiBaseUrl,
      anthropicBaseUrl: mock.anthropicBaseUrl,
    });
    installUserCodexHome(omni, mock.openaiBaseUrl, CODEX_MODEL);
    startOmnigent(omni, ["codex", PROMPT]);
    try {
      await waitFor(
        "the bridged Codex session to record the scripted answer",
        () =>
          filesContaining(omni.dataDir, FINAL).some((f) =>
            f.endsWith(".jsonl"),
          ),
        180_000,
      );
    } catch (error) {
      // The Codex TUI can stop on a first-run prompt; show what it is waiting on.
      console.error(screen(omni));
      throw error;
    }
    // Let Codex finish writing the turn, then close the terminal.
    await Bun.sleep(2_000);
    stopTerminal(omni);
    const conversations = await listOmnigentConversations(omni.dataDir);
    conversation = conversations.find((c) => c.kind === "default")!;
    session = (await listOmnigentCodexSessions(omni.dataDir))[0]!;
  }, 300_000);

  afterAll(async () => {
    saveArtifacts("omnigent-native", omni.dataDir);
    await mock.stop();
  });

  it("creates a native rollout in a private bridge home, keyed by the conversation id", () => {
    expect(conversation).toBeDefined();
    expect(session).toBeDefined();
    expect(session.bridgeHash).toBe(omnigentBridgeHash(conversation.id));
    expect(session.rolloutPath).toContain(
      `/codex-native/${session.bridgeHash}/codex-home/sessions/`,
    );
    expect(session.conversationId).toBe(conversation.id);
    expect(session.kind).toBe("default");
    expect(session.cwd).toBe(omni.project);
  });

  it("reached the mock and left no unscripted request", () => {
    expect(mock.requestsOn("responses").length).toBeGreaterThanOrEqual(2);
    expect(mock.unmatchedSummary()).toEqual([]);
  });

  it("dry run lists the session and changes nothing", async () => {
    const target = await warmCodex("warm-up bridge dry");
    const before = threadRows(target.codexHome).length;
    const result = await runCodexSync(omni, ["--codex-home", target.codexHome]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain(`would sync: ${session.threadId}`);
    expect(result.stdout).toContain("(dry run)");
    expect(threadRows(target.codexHome)).toHaveLength(before);
  }, 240_000);

  it("--apply copies the rollout, indexes it, and Codex resumes it with its history", async () => {
    const target = await warmCodex("warm-up bridge apply");
    const applied = await runCodexSync(omni, [
      "--codex-home",
      target.codexHome,
      "--apply",
    ]);
    expect(applied.code).toBe(0);
    expect(applied.stdout).toContain(`sync: ${session.threadId}`);
    const row = threadRows(target.codexHome).find(
      (r) => r.id === session.threadId,
    );
    expect(row?.preview).toBe(PROMPT);
    expect(
      findRollouts(target.codexHome).some((p) => p.includes(session.threadId)),
    ).toBe(true);

    mock.script([
      {
        match: { userMessage: "bridge follow-up" },
        response: { content: "Bridge follow-up answer." },
      },
    ]);
    mock.clearRequests();
    // The output Codex really recorded for the call, whatever the command did.
    const recordedOutput = String(
      readRollout(session.rolloutPath).find(
        (line) => line.payload.type === "function_call_output",
      )!.payload.output,
    );
    const resumed = await resumeInTui(
      target,
      mock,
      session.threadId,
      "bridge follow-up",
    );
    expect(resumed.reached).toBe(true);
    expect(resumed.screen).toContain("Bridge follow-up answer.");
    const positions = locateHistory(
      mock.historyForUserText("bridge follow-up")!,
      {
        prompt: PROMPT,
        callId: "call_bridge_echo",
        toolName: "exec_command",
        toolOutput: recordedOutput.split("\n")[0]!,
        final: FINAL,
        followUp: "bridge follow-up",
      },
    );
    for (const index of positions) expect(index).toBeGreaterThanOrEqual(0);
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
    expect(mock.unmatchedSummary()).toEqual([]);

    // A second apply skips the rollout already present and adds no thread row.
    const again = await runCodexSync(omni, [
      "--codex-home",
      target.codexHome,
      "--apply",
    ]);
    expect(again.stdout).toContain(
      `skip (already present): ${session.threadId}`,
    );
    expect(
      threadRows(target.codexHome).filter((r) => r.id === session.threadId),
    ).toHaveLength(1);
  }, 300_000);

  it("--sub-agents-only finds none for a plain native session", async () => {
    const target = await warmCodex("warm-up bridge subs");
    const result = await runCodexSync(omni, [
      "--codex-home",
      target.codexHome,
      "--sub-agents-only",
    ]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("0 rollouts found");
  }, 240_000);
});
