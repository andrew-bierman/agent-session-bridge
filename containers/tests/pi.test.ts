import { afterAll, beforeAll, expect, it } from "bun:test";
import { readdirSync } from "node:fs";
import { join } from "node:path";

import {
  exportClaudeSession,
  exportCodexSession,
  loadSourceSessionSnapshot,
  type NormalizedMessage,
} from "../../packages/core/src/index.js";
import {
  createClaudeSandbox,
  resumeArgs as claudeResumeArgs,
  runClaude,
} from "./support/claude.js";
import {
  createCodexSandbox,
  execArgs,
  resumeInTui,
  runCodex,
  threadRows,
} from "./support/codex.js";
import { textOf } from "./support/history.js";
import {
  describeToolInContainer,
  saveArtifacts,
} from "./support/in-container.js";
import { ScriptedMock } from "./support/mock.js";
import { createPiSandbox, runPi, type PiSandbox } from "./support/pi.js";

const PROMPT = "Run echo hello-from-pi and tell me what it printed.";
const FINAL = "The command printed hello-from-pi.";
const SESSION = "01a20c10-0000-7000-8000-000000000001";

let mock: ScriptedMock;
let pi: PiSandbox;
let messages: NormalizedMessage[];

function sessionFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.name.endsWith(".jsonl")) out.push(path);
    }
  };
  try {
    walk(root);
  } catch {
    // no sessions directory yet
  }
  return out.sort();
}

describeToolInContainer(
  "pi",
  "real Pi against the mock, round-tripped through the bridge",
  () => {
    beforeAll(async () => {
      mock = await ScriptedMock.start();
      mock.toolRound(
        PROMPT,
        {
          id: "call_pi_echo",
          name: "bash",
          args: { command: "echo hello-from-pi" },
        },
        FINAL,
      );
      pi = createPiSandbox(mock.openaiBaseUrl);
    });
    afterAll(async () => {
      saveArtifacts("pi-real", pi.agentDir);
      await mock.stop();
    });

    it("runs a scripted tool-call turn and writes a session", async () => {
      const result = await runPi(pi, PROMPT);
      if (result.code !== 0) console.error(result.stdout, result.stderr);
      expect(result.code).toBe(0);
      expect(mock.requestsOn("chat").length).toBeGreaterThanOrEqual(2);
      expect(mock.unmatchedSummary()).toEqual([]);
      expect(sessionFiles(join(pi.agentDir, "sessions"))).toHaveLength(1);
    }, 180_000);

    it("loads through the bridge with the prompt, tool call, tool result, and answer preserved", async () => {
      const [path] = sessionFiles(join(pi.agentDir, "sessions"));
      const snapshot = await loadSourceSessionSnapshot("pi", path!);
      messages = snapshot.chunks.map((chunk) => chunk.message);
      const blocks = messages.flatMap((m) => m.content);
      expect(messages[0]).toMatchObject({ role: "user" });
      expect(textOf(messages[0]!)).toContain(PROMPT);
      for (const message of messages) {
        expect(
          message.content.some(
            (b) => b.type !== "text" || b.text.trim() !== "",
          ),
        ).toBe(true);
      }
      expect(blocks).toContainEqual(
        expect.objectContaining({
          type: "tool_call",
          id: "call_pi_echo",
          name: "bash",
          arguments: { command: "echo hello-from-pi" },
        }),
      );
      const result = blocks.find((b) => b.type === "tool_result");
      expect(result).toMatchObject({ toolCallId: "call_pi_echo" });
      // Plain text, not a JSON-encoded content array.
      expect((result as { output: string }).output).toBe("hello-from-pi\n");
      expect(JSON.stringify(messages)).toContain(FINAL);
    });

    it("exports to Claude Code, which resumes it with the Pi history", async () => {
      const target = createClaudeSandbox(mock.anthropicBaseUrl);
      const exported = await exportClaudeSession({
        messages,
        cwd: target.project,
        sessionId: SESSION,
        homeDir: target.homeDir,
      });
      expect(exported.status).toBe("exported");
      mock.script([
        {
          match: { userMessage: "pi to claude follow-up" },
          response: { content: "Claude saw Pi." },
        },
      ]);
      mock.clearRequests();
      const resumed = await runClaude(
        target,
        claudeResumeArgs(SESSION, "pi to claude follow-up"),
      );
      expect(resumed.code).toBe(0);
      expect(resumed.stdout).toContain("Claude saw Pi.");
      const history = mock.historyForUserText("pi to claude follow-up")!;
      expect(
        history.some((m) => m.role === "user" && textOf(m).includes(PROMPT)),
      ).toBe(true);
      expect(
        history.some(
          (m) => m.role === "assistant" && textOf(m).includes(FINAL),
        ),
      ).toBe(true);
      expect(
        history.some((m) =>
          m.tool_calls?.some((c) => c.function?.name === "bash"),
        ),
      ).toBe(true);
    }, 240_000);

    it("exports to Codex, which resumes it with the Pi history", async () => {
      const target = createCodexSandbox(mock.openaiBaseUrl);
      mock.script([
        {
          match: { userMessage: "warm-up pi" },
          response: { content: "warm ok" },
        },
      ]);
      expect(
        (await runCodex(target, execArgs(target.project, "warm-up pi"))).code,
      ).toBe(0);
      const exported = await exportCodexSession({
        messages,
        cwd: target.project,
        sessionId: SESSION,
        codexHome: target.codexHome,
        homeDir: target.homeDir,
      });
      expect(exported.indexed?.indexed).toBe(true);
      expect(
        threadRows(target.codexHome).find((r) => r.id === SESSION)?.preview,
      ).toBe(PROMPT);

      mock.script([
        {
          match: { userMessage: "pi to codex follow-up" },
          response: { content: "Codex saw Pi." },
        },
      ]);
      mock.clearRequests();
      const resumed = await resumeInTui(
        target,
        mock,
        SESSION,
        "pi to codex follow-up",
      );
      expect(resumed.reached).toBe(true);
      expect(resumed.screen).toContain("Codex saw Pi.");
      const history = mock.historyForUserText("pi to codex follow-up")!;
      expect(
        history.some((m) => m.role === "user" && textOf(m).includes(PROMPT)),
      ).toBe(true);
      expect(
        history.some(
          (m) => m.role === "assistant" && textOf(m).includes(FINAL),
        ),
      ).toBe(true);
      expect(
        history.some((m) =>
          m.tool_calls?.some((c) => c.function?.name === "bash"),
        ),
      ).toBe(true);
      expect(mock.unmatchedSummary()).toEqual([]);
    }, 300_000);
  },
);
