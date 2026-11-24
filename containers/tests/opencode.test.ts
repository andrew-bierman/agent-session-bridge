import { afterAll, beforeAll, expect, it } from "bun:test";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
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
  findRollouts,
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
import {
  OPENCODE_MODEL,
  createOpenCodeSandbox,
  runOpenCode,
  type OpenCodeSandbox,
} from "./support/opencode.js";

const PROMPT = "Run echo hello-from-opencode and tell me what it printed.";
const FINAL = "The command printed hello-from-opencode.";
const SESSION = "01a20c11-0000-7000-8000-000000000001";

let mock: ScriptedMock;
let oc: OpenCodeSandbox;
let exportPath: string;
let messages: NormalizedMessage[];

// The bridge reads OpenCode 2.3's v2 session export, so this runs a second,
// pinned OpenCode 2.x (the 1.x binary exists only for Omnigent).
describeToolInContainer(
  "opencodeV2",
  "real OpenCode against the mock, round-tripped through the bridge",
  () => {
    beforeAll(async () => {
      mock = await ScriptedMock.start();
      mock.toolRound(
        PROMPT,
        {
          id: "call_oc_echo",
          name: "shell",
          args: {
            command: "echo hello-from-opencode",
            description: "Print a greeting",
          },
        },
        FINAL,
      );
      oc = createOpenCodeSandbox(mock.openaiBaseUrl);
    });
    afterAll(async () => {
      saveArtifacts("opencode-real", oc.root);
      await mock.stop();
    });

    it("runs a scripted tool-call turn and records a session", async () => {
      const result = await runOpenCode(oc, [
        "run",
        "-m",
        OPENCODE_MODEL,
        PROMPT,
      ]);
      if (result.code !== 0) console.error(result.stdout, result.stderr);
      expect(result.code).toBe(0);
      expect(mock.unmatchedSummary()).toEqual([]);
      expect(result.stdout).toContain(FINAL);
    }, 180_000);

    it("exports its v2 session and loads through the bridge with the whole turn preserved", async () => {
      const list = await runOpenCode(oc, [
        "session",
        "list",
        "--format",
        "json",
      ]);
      const sessions = JSON.parse(list.stdout) as { id: string }[];
      expect(sessions).toHaveLength(1);
      const exported = await runOpenCode(oc, [
        "session",
        "export",
        "--standalone",
        sessions[0]!.id,
      ]);
      if (exported.code !== 0) console.error(exported.stderr);
      expect(exported.code).toBe(0);
      exportPath = join(oc.root, "export.json");
      writeFileSync(exportPath, exported.stdout);
      const snapshot = await loadSourceSessionSnapshot("opencode", exportPath);
      messages = snapshot.chunks.map((chunk) => chunk.message);
      const blocks = messages.flatMap((m) => m.content);
      expect(messages[0]).toMatchObject({ role: "user" });
      expect(textOf(messages[0]!)).toContain(PROMPT);
      // A settled OpenCode tool call crosses as a labeled record that keeps the
      // call id, the command and its real output; it is not replayed as a call.
      const record = blocks.find(
        (b) =>
          b.type === "text" &&
          b.text.includes("Historical OpenCode tool record"),
      );
      expect(record).toBeDefined();
      const text = (record as { text: string }).text;
      expect(text).toContain('"id":"call_oc_echo"');
      expect(text).toContain('"command":"echo hello-from-opencode"');
      expect(text).toContain('"output":["hello-from-opencode\\n"]');
      expect(JSON.stringify(messages)).toContain(FINAL);
    });

    it("exports to Claude Code, which resumes it with the OpenCode history", async () => {
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
          match: { userMessage: "opencode to claude follow-up" },
          response: { content: "Claude saw OpenCode." },
        },
      ]);
      mock.clearRequests();
      const resumed = await runClaude(
        target,
        claudeResumeArgs(SESSION, "opencode to claude follow-up"),
      );
      expect(resumed.code).toBe(0);
      expect(resumed.stdout).toContain("Claude saw OpenCode.");
      const history = mock.historyForUserText("opencode to claude follow-up")!;
      expect(
        history.some((m) => m.role === "user" && textOf(m).includes(PROMPT)),
      ).toBe(true);
      expect(
        history.some(
          (m) => m.role === "assistant" && textOf(m).includes(FINAL),
        ),
      ).toBe(true);
      expect(
        history.some(
          (m) =>
            textOf(m).includes("Historical OpenCode tool record") &&
            textOf(m).includes("hello-from-opencode"),
        ),
      ).toBe(true);
    }, 240_000);

    it("exports to Codex, which resumes it with the OpenCode history", async () => {
      const target = createCodexSandbox(mock.openaiBaseUrl);
      mock.script([
        {
          match: { userMessage: "warm-up opencode" },
          response: { content: "warm ok" },
        },
      ]);
      expect(
        (await runCodex(target, execArgs(target.project, "warm-up opencode")))
          .code,
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
          match: { userMessage: "opencode to codex follow-up" },
          response: { content: "Codex saw OpenCode." },
        },
      ]);
      mock.clearRequests();
      const resumed = await resumeInTui(
        target,
        mock,
        SESSION,
        "opencode to codex follow-up",
      );
      expect(resumed.reached).toBe(true);
      expect(resumed.screen).toContain("Codex saw OpenCode.");
      const history = mock.historyForUserText("opencode to codex follow-up")!;
      expect(
        history.some((m) => m.role === "user" && textOf(m).includes(PROMPT)),
      ).toBe(true);
      expect(
        history.some(
          (m) => m.role === "assistant" && textOf(m).includes(FINAL),
        ),
      ).toBe(true);
      expect(
        history.some(
          (m) =>
            textOf(m).includes("Historical OpenCode tool record") &&
            textOf(m).includes("hello-from-opencode"),
        ),
      ).toBe(true);
      expect(mock.unmatchedSummary()).toEqual([]);
    }, 300_000);

    it("seeds a real Codex session into OpenCode, which resumes it with the Codex history", async () => {
      const codex = createCodexSandbox(mock.openaiBaseUrl);
      mock.reply("seed source prompt", "seed source answer");
      const made = await runCodex(
        codex,
        execArgs(codex.project, "seed source prompt"),
      );
      expect(made.code).toBe(0);
      const [rollout] = findRollouts(codex.codexHome);
      expect(rollout).toBeDefined();

      const target = createOpenCodeSandbox(mock.openaiBaseUrl);
      // A first run lets OpenCode create and migrate its own database.
      const init = await runOpenCode(target, [
        "session",
        "list",
        "--standalone",
        "--format",
        "json",
      ]);
      expect(init.code).toBe(0);

      // The bridge CLI runs `opencode` from PATH; make that the 2.x binary it
      // supports instead of the 1.x one the image keeps for Omnigent.
      const shim = join(target.root, "bin");
      mkdirSync(shim);
      symlinkSync("/opt/opencode2/opencode", join(shim, "opencode"));
      const seeded = Bun.spawnSync(
        [
          "bun",
          join(import.meta.dir, "support", "bridge-cli.ts"),
          "seed-opencode",
          "codex",
          rollout!,
          target.dbPath,
        ],
        {
          env: {
            ...target.env,
            OPENCODE_DB: target.dbPath,
            PATH: `${shim}:${target.env.PATH}`,
          },
          cwd: target.project,
        },
      );
      const out = `${seeded.stdout.toString()}${seeded.stderr.toString()}`;
      const id = out.match(/OpenCode (ses_[a-zA-Z0-9]+): verified/)?.[1];
      expect(id, out).toBeDefined();

      mock.reply("seed follow-up", "OpenCode saw the Codex session.");
      mock.clearRequests();
      const resumed = await runOpenCode(
        { ...target, env: { ...target.env, OPENCODE_DB: target.dbPath } },
        ["run", "-m", OPENCODE_MODEL, "-s", id!, "seed follow-up"],
      );
      if (resumed.code !== 0) console.error(resumed.stdout, resumed.stderr);
      expect(resumed.code).toBe(0);
      expect(resumed.stdout).toContain("OpenCode saw the Codex session.");
      const history = mock.historyForUserText("seed follow-up")!;
      expect(
        history.some(
          (m) => m.role === "user" && textOf(m).includes("seed source prompt"),
        ),
      ).toBe(true);
      expect(
        history.some(
          (m) =>
            m.role === "assistant" && textOf(m).includes("seed source answer"),
        ),
      ).toBe(true);
    }, 300_000);
  },
);
