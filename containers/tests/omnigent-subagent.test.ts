import { afterAll, beforeAll, expect, it } from "bun:test";
import { join } from "node:path";

import {
  listOmnigentCodexSessions,
  listOmnigentConversations,
  omnigentCodexThreadId,
  readOmnigentConversationMessages,
  type OmnigentConversationInfo,
} from "../../packages/core/src/index.js";
import {
  createClaudeSandbox,
  findSessions,
  readSession,
  resumeArgs as claudeResumeArgs,
  runClaude,
  blocksOf,
} from "./support/claude.js";
import {
  createCodexSandbox,
  execArgs,
  findRollouts,
  readRollout,
  resumeArgs as codexResumeArgs,
  runCodex,
  threadRows,
  type CodexSandbox,
} from "./support/codex.js";
import { historyOf, textOf } from "./support/history.js";
import { describeInContainer, saveArtifacts } from "./support/in-container.js";
import { ScriptedMock } from "./support/mock.js";
import {
  createOmnigentSandbox,
  filesContaining,
  runExporter,
  screen,
  startOmnigent,
  waitFor,
  type OmnigentSandbox,
} from "./support/omnigent.js";

const QUESTION =
  "Give me one short name idea for a CLI that runs coding agents.";
const ANSWER = "Runcrew";
const PARENT_FINAL = "GPT suggests: Runcrew";

let mock: ScriptedMock;
let omni: OmnigentSandbox;
let parent: OmnigentConversationInfo;
let child: OmnigentConversationInfo;

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

const index = (
  history: ReturnType<typeof historyOf>,
  test: (m: (typeof history)[number]) => boolean,
) => history.findIndex(test);

describeInContainer(
  "Omnigent parent delegating to a spec-defined sub-agent",
  () => {
    beforeAll(async () => {
      mock = await ScriptedMock.start();
      mock.script([
        // Session-title calls Omnigent makes on its own, on both model families.
        {
          match: { systemMessage: "naming a coding session" },
          response: { content: "CLI name idea" },
        },
        {
          match: { systemMessage: "concise 2-5 word title" },
          response: { content: "CLI name idea" },
        },
        {
          match: { userMessage: "<user_message>", model: "gpt-5.6-luna" },
          response: { content: "CLI name idea" },
        },
        // The Codex-harness sub-agent answers the delegated question.
        {
          match: { systemMessage: "plain responder" },
          response: { content: ANSWER },
        },
        // The Claude Agent SDK parent: read the inbox, relay; delegate, then wait.
        {
          match: {
            systemMessage: "test orchestrator",
            toolCallId: "toolu_inbox_1",
          },
          response: { content: PARENT_FINAL },
        },
        {
          match: {
            systemMessage: "test orchestrator",
            toolCallId: "toolu_send_1",
          },
          response: { content: "Delegated to gpt; relaying when it answers." },
        },
        {
          match: {
            systemMessage: "test orchestrator",
            userMessage: "result waiting in inbox",
          },
          response: {
            toolCalls: [
              {
                id: "toolu_inbox_1",
                name: "mcp__omnigent__sys_read_inbox",
                arguments: {},
              },
            ],
          },
        },
        {
          match: { systemMessage: "test orchestrator", userMessage: QUESTION },
          response: {
            toolCalls: [
              {
                id: "toolu_send_1",
                name: "mcp__omnigent__sys_session_send",
                arguments: {
                  agent: "gpt",
                  title: "name-idea-gpt",
                  args: QUESTION,
                },
              },
            ],
          },
        },
      ]);
      omni = createOmnigentSandbox({
        openaiBaseUrl: mock.openaiBaseUrl,
        anthropicBaseUrl: mock.anthropicBaseUrl,
      });
      startOmnigent(omni, ["run", omni.agentDir, "-p", QUESTION]);
      await waitFor(
        "Omnigent to finish the delegated run",
        () => screen(omni).includes("OMNI_EXITED"),
        240_000,
      );
      const conversations = await listOmnigentConversations(omni.dataDir);
      parent = conversations.find((c) => c.kind === "default")!;
      child = conversations.find((c) => c.kind === "sub_agent")!;
    }, 300_000);

    afterAll(async () => {
      saveArtifacts("omnigent-run", omni.dataDir);
      await mock.stop();
    });

    it("records a parent and a sub-agent conversation, linked, in chat.db", () => {
      expect(parent).toBeDefined();
      expect(child).toBeDefined();
      expect(child.parentId).toBe(parent.id);
      expect(child.rootId).toBe(parent.id);
      expect(child.subAgentName).toBe("gpt");
      expect(parent.workspace).toBe(omni.project);
    });

    it("stores the sub-agent's prompt and scripted answer, and the parent's delegation", async () => {
      const childMessages = await readOmnigentConversationMessages(
        omni.dataDir,
        child.id,
      );
      expect(childMessages.map((m) => [m.role, m.content[0]])).toEqual([
        ["user", { type: "text", text: QUESTION }],
        ["assistant", { type: "text", text: ANSWER }],
      ]);

      const parentMessages = await readOmnigentConversationMessages(
        omni.dataDir,
        parent.id,
      );
      const blocks = parentMessages.flatMap((m) => m.content);
      expect(blocks).toContainEqual(
        expect.objectContaining({
          type: "tool_call",
          id: "toolu_send_1",
          name: "sys_session_send",
          arguments: { agent: "gpt", title: "name-idea-gpt", args: QUESTION },
        }),
      );
      expect(blocks).toContainEqual(
        expect.objectContaining({
          type: "tool_result",
          toolCallId: "toolu_send_1",
        }),
      );
      expect(JSON.stringify(parentMessages)).toContain(PARENT_FINAL);
    });

    it("reached the mock on both wires and left no unscripted request", () => {
      expect(mock.requestsOn("messages").length).toBeGreaterThan(0);
      expect(mock.requestsOn("responses").length).toBeGreaterThan(0);
      expect(mock.unmatchedSummary()).toEqual([]);
    });

    it("leaves no native Codex or Claude session for the sub-agent before export", async () => {
      const sessions = await listOmnigentCodexSessions(omni.dataDir);
      expect(sessions.filter((s) => s.conversationId === child.id)).toEqual([]);
      expect(filesContaining(join(omni.homeDir, ".claude"), ANSWER)).toEqual(
        [],
      );
    });

    it("exports the sub-agent as a native Codex session that resumes with its history", async () => {
      const target = await warmCodex("warm-up omni codex");
      const exported = await runExporter(omni, [
        "--target",
        "codex",
        "--sub-agents-only",
        "--cwd",
        target.project,
        "--codex-home",
        target.codexHome,
        "--apply",
      ]);
      expect(exported.code).toBe(0);
      const id = omnigentCodexThreadId(child.id);
      expect(
        threadRows(target.codexHome).find((r) => r.id === id)?.preview,
      ).toBe(QUESTION);

      mock.script([
        {
          match: { userMessage: "follow-up question" },
          response: { content: "Follow-up answer." },
        },
      ]);
      mock.clearRequests();
      const resumed = await runCodex(
        target,
        codexResumeArgs(id, "follow-up question"),
      );
      expect(resumed.code).toBe(0);
      expect(resumed.stdout).toContain("Follow-up answer.");
      const history = historyOf(
        mock.requestsContaining("follow-up question")[0]!.body,
      );
      const asked = index(
        history,
        (m) => m.role === "user" && textOf(m).includes(QUESTION),
      );
      const answered = index(
        history,
        (m) => m.role === "assistant" && textOf(m).includes(ANSWER),
      );
      const followUp = index(
        history,
        (m) => m.role === "user" && textOf(m).includes("follow-up question"),
      );
      expect(asked).toBeGreaterThanOrEqual(0);
      expect(answered).toBeGreaterThan(asked);
      expect(followUp).toBeGreaterThan(answered);
      expect(findRollouts(target.codexHome).some((p) => p.includes(id))).toBe(
        true,
      );
      expect(mock.unmatchedSummary()).toEqual([]);
    }, 300_000);

    it("exports the sub-agent as a native Claude Code session that resumes with its history", async () => {
      const target = createClaudeSandbox(mock.anthropicBaseUrl);
      const exported = await runExporter(omni, [
        "--target",
        "claude",
        "--sub-agents-only",
        "--cwd",
        target.project,
        "--claude-home",
        target.homeDir,
        "--apply",
      ]);
      expect(exported.code).toBe(0);
      const id = omnigentCodexThreadId(child.id);
      const lines = readSession(findSessions(target.configDir)[0]!);
      expect(lines.map((l) => blocksOf(l)[0])).toEqual([
        { type: "text", text: QUESTION },
        { type: "text", text: ANSWER },
      ]);

      mock.script([
        {
          match: { userMessage: "claude follow-up" },
          response: { content: "Claude follow-up answer." },
        },
      ]);
      mock.clearRequests();
      const resumed = await runClaude(
        target,
        claudeResumeArgs(id, "claude follow-up"),
      );
      expect(resumed.code).toBe(0);
      expect(resumed.stdout).toContain("Claude follow-up answer.");
      const history = historyOf(
        mock.requestsContaining("claude follow-up")[0]!.body,
      );
      const asked = index(
        history,
        (m) => m.role === "user" && textOf(m).includes(QUESTION),
      );
      const answered = index(
        history,
        (m) => m.role === "assistant" && textOf(m).includes(ANSWER),
      );
      expect(asked).toBeGreaterThanOrEqual(0);
      expect(answered).toBeGreaterThan(asked);
    }, 240_000);

    it("exports the parent with its delegation and inbox read, and Codex replays them in order", async () => {
      const target = await warmCodex("warm-up omni parent");
      const exported = await runExporter(omni, [
        "--target",
        "codex",
        "--conversation",
        parent.id,
        "--cwd",
        target.project,
        "--codex-home",
        target.codexHome,
        "--apply",
      ]);
      expect(exported.code).toBe(0);
      const id = omnigentCodexThreadId(parent.id);

      mock.script([
        {
          match: { userMessage: "parent follow-up" },
          response: { content: "Parent follow-up answer." },
        },
      ]);
      mock.clearRequests();
      const resumed = await runCodex(
        target,
        codexResumeArgs(id, "parent follow-up"),
      );
      expect(resumed.code).toBe(0);
      const history = historyOf(
        mock.requestsContaining("parent follow-up")[0]!.body,
      );
      const callOf = (name: string) =>
        history.findIndex((m) =>
          m.tool_calls?.some((c) => c.function?.name === name),
        );
      const send = callOf("sys_session_send");
      const inbox = callOf("sys_read_inbox");
      const wake = index(
        history,
        (m) =>
          m.role === "user" &&
          textOf(m).includes("sub-agent gpt/name-idea-gpt finished"),
      );
      const final = index(
        history,
        (m) => m.role === "assistant" && textOf(m).includes(PARENT_FINAL),
      );
      for (const position of [send, wake, inbox, final])
        expect(position).toBeGreaterThanOrEqual(0);
      expect(send).toBeLessThan(wake);
      expect(wake).toBeLessThan(inbox);
      expect(inbox).toBeLessThan(final);
      // The delegation call and its output are paired, with the output after the call.
      const sendId = history[send]!.tool_calls![0]!.id;
      const sendOutput = history.findIndex(
        (m) => m.role === "tool" && m.tool_call_id === sendId,
      );
      expect(sendOutput).toBeGreaterThan(send);
      expect(mock.unmatchedSummary()).toEqual([]);
    }, 300_000);

    it("skips a conversation that is already exported", async () => {
      const target = await warmCodex("warm-up omni again");
      const args = [
        "--target",
        "codex",
        "--sub-agents-only",
        "--cwd",
        target.project,
        "--codex-home",
        target.codexHome,
        "--apply",
      ];
      expect((await runExporter(omni, args)).code).toBe(0);
      const again = await runExporter(omni, args);
      expect(again.stdout).toContain("skip (already present)");
      expect(again.stdout).toContain("0 exported");
      const id = omnigentCodexThreadId(child.id);
      expect(
        threadRows(target.codexHome).filter((r) => r.id === id),
      ).toHaveLength(1);
      expect(
        readRollout(
          findRollouts(target.codexHome).find((p) => p.includes(id))!,
        )[0]!.type,
      ).toBe("session_meta");
    }, 240_000);

    it("fails without writing when asked to export a conversation that does not exist", async () => {
      const target = createClaudeSandbox(mock.anthropicBaseUrl);
      const result = await runExporter(omni, [
        "--target",
        "claude",
        "--conversation",
        "ffffffffffffffffffffffffffffffff",
        "--cwd",
        target.project,
        "--claude-home",
        target.homeDir,
        "--apply",
      ]);
      expect(result.code).toBe(1);
      expect(findSessions(target.configDir)).toEqual([]);
    });
  },
);
