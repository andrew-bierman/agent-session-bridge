import { afterAll, beforeAll, expect, it } from "bun:test";

import {
  createCodexSandbox,
  execArgs,
  findRollouts,
  readRollout,
  runCodex,
  threadRows,
  type CodexSandbox,
} from "./support/codex.js";
import { describeInContainer } from "./support/in-container.js";
import { ScriptedMock } from "./support/mock.js";

const PROMPT = "Run echo hello-from-codex and tell me what it printed.";
const FINAL = "The command printed hello-from-codex.";

let mock: ScriptedMock;
let sandbox: CodexSandbox;

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
    sandbox = createCodexSandbox(mock.openaiBaseUrl);
  });
  afterAll(async () => {
    await mock.stop();
  });

  it("runs a scripted tool-call turn and writes a rollout and a thread row", async () => {
    const result = await runCodex(sandbox, execArgs(sandbox.project, PROMPT));
    if (result.code !== 0) {
      console.error(result.stdout, result.stderr, JSON.stringify(mock.requests().map((r) => ({ path: r.path, status: r.response.status, body: r.body })), null, 1));
    }
    expect(result.code).toBe(0);
    expect(mock.requestsOn("responses").length).toBeGreaterThanOrEqual(2);
    expect(mock.unmatched()).toHaveLength(0);

    const rollouts = findRollouts(sandbox.codexHome);
    expect(rollouts).toHaveLength(1);
    const lines = readRollout(rollouts[0]!);
    expect(lines[0]!.type).toBe("session_meta");
    expect(JSON.stringify(lines)).toContain("hello-from-codex");
    expect(JSON.stringify(lines)).toContain(FINAL);

    const threads = threadRows(sandbox.codexHome);
    expect(threads).toHaveLength(1);
    expect(threads[0]!.preview).toBe(PROMPT);
  }, 180_000);
});
