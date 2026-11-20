import { execFile, execFileSync } from "node:child_process";
import {
  appendFileSync,
  copyFileSync,
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  returnCodexTurnsToOpenCode,
  syncSourceSessionToTargets,
} from "../src/runtime.js";
import { describe, expect, it } from "vitest";
import {
  appendOpenCodeMessages,
  type OpenCodeMessageRow,
} from "../src/opencode-store.js";

describe.runIf(process.env.TEST_OPENCODE === "1")(
  "OpenCode native store",
  () => {
    it("reopens the original session with an appended turn and rejects divergent writes", async () => {
      const root = mkdtempSync(join(tmpdir(), "bridge-opencode-"));
      let modelRequest = "";
      const provider = createServer(async (request, response) => {
        if (request.url !== "/v1/chat/completions") {
          response.writeHead(404).end();
          return;
        }
        for await (const chunk of request) modelRequest += chunk.toString();
        const frame = (delta: object, finish_reason: string | null) =>
          JSON.stringify({
            id: "test",
            object: "chat.completion.chunk",
            created: 1,
            model: "test",
            choices: [{ index: 0, delta, finish_reason }],
          });
        response.writeHead(200, { "Content-Type": "text/event-stream" });
        response.end(
          `data: ${frame({ role: "assistant", content: "Offline continuation" }, null)}\n\ndata: ${frame({}, "stop")}\n\ndata: [DONE]\n\n`,
        );
      });
      try {
        await new Promise<void>((resolve, reject) =>
          provider.once("error", reject).listen(0, "127.0.0.1", resolve),
        );
        const address = provider.address();
        if (!address || typeof address === "string")
          throw new Error("Missing fixture server port");
        const project = join(root, "project");
        mkdirSync(project);
        const config = join(project, "opencode.json");
        writeFileSync(
          config,
          JSON.stringify({
            warming: false,
            providers: {
              fixture: {
                package: "@opencode/ai/providers/openai-compatible",
                settings: {
                  apiKey: "fake-only",
                  baseURL: `http://127.0.0.1:${address.port}/v1`,
                },
                models: { test: { limit: { context: 64000, output: 4096 } } },
              },
            },
          }),
        );
        const options = {
          cwd: project,
          encoding: "utf8" as const,
          timeout: 15000,
          env: {
            PATH: process.env.PATH,
            HOME: root,
            OPENCODE_CONFIG: config,
            OPENCODE_DISABLE_AUTOUPDATE: "true",
            XDG_DATA_HOME: join(root, "data"),
            XDG_CONFIG_HOME: join(root, "config"),
            XDG_STATE_HOME: join(root, "state"),
            XDG_CACHE_HOME: join(root, "cache"),
          },
        };
        const opencode = (...args: string[]) =>
          execFileSync("opencode", args, options);
        const version = opencode("--version")
          .trim()
          .replace(/^opencode v/, "");
        const id = "ses_0000000000000000000000000000001";
        const originalId = "msg_0000000000000000000000000000001";
        const now = Date.now();
        const model = { id: "test", providerID: "fixture" };
        const tokens = {
          input: 0,
          output: 0,
          reasoning: 0,
          cache: { read: 0, write: 0 },
        };
        const bundle = join(root, "session.json");
        writeFileSync(
          bundle,
          JSON.stringify({
            info: {
              id,
              projectID: "global",
              title: "Isolated test",
              agent: "build",
              model,
              location: { directory: project },
              cost: 0,
              tokens,
              time: { created: now, updated: now },
            },
            messages: [
              {
                id: originalId,
                type: "user",
                text: "Initial prompt",
                time: { created: now },
              },
            ],
          }),
        );
        opencode("session", "import", "--standalone", bundle);
        const path = join(root, "data", "opencode", "opencode.db");
        const db = new DatabaseSync(path, { readOnly: true });
        const baseline = db
          .prepare(
            "SELECT id, type, seq, time_created, time_updated, data FROM session_message WHERE session_id = ? ORDER BY seq",
          )
          .all(id) as unknown as OpenCodeMessageRow[];
        db.close();
        expect(baseline).toHaveLength(1);
        const turn: OpenCodeMessageRow = {
          id: "msg_0000000000000000000000000000002",
          type: "assistant",
          seq: 2,
          time_created: now + 1,
          time_updated: now + 1,
          data: JSON.stringify({
            agent: "build",
            model,
            tokens,
            cost: 0,
            finish: "stop",
            time: { created: now + 1, completed: now + 1 },
            content: [
              { type: "text", text: "Original session retains this turn" },
            ],
          }),
        };
        expect(
          appendOpenCodeMessages(path, version, id, baseline, [turn]),
        ).toBe(1);
        expect(
          appendOpenCodeMessages(path, version, id, baseline, [turn]),
        ).toBe(0);
        expect(() =>
          appendOpenCodeMessages(path, version, id, baseline, [
            { ...turn, id: "msg_0000000000000000000000000000003" },
          ]),
        ).toThrow("history diverged");
        const exported = JSON.parse(
          opencode("session", "export", "--standalone", id),
        );
        expect(exported.info.id).toBe(id);
        const exportPath = join(root, "export.json");
        writeFileSync(exportPath, JSON.stringify(exported));
        const sync = () =>
          syncSourceSessionToTargets({
            sourceTool: "opencode",
            sourcePath: exportPath,
            homeDir: root,
            registryPath: join(root, "registry.json"),
            targetTools: ["codex"],
          });
        const first = await sync();
        expect(first.writes[0]?.appendedCount).toBeGreaterThan(0);
        expect((await sync()).writes[0]?.appendedCount).toBe(0);
        writeFileSync(
          exportPath,
          JSON.stringify({
            ...exported,
            messages: [
              { ...exported.messages[0], text: "Modified history" },
              exported.messages[1],
            ],
          }),
        );
        await expect(sync()).rejects.toThrow(
          "OpenCode export history diverged",
        );

        expect(
          exported.messages.map((message: { id: string }) => message.id),
        ).toEqual([originalId, turn.id]);
        expect(exported.messages[1].content).toEqual([
          { type: "text", text: "Original session retains this turn" },
        ]);
        const codex = first.writes[0]!;
        const live = process.env.TEST_CODEX_LIVE === "1";
        const returnedText = live
          ? "Original session retains this turn"
          : "Codex imported answer";
        if (live) {
          const isolatedCodex = join(root, ".codex");
          const auth = join(isolatedCodex, "auth.json");
          copyFileSync(
            join(
              process.env.CODEX_HOME ?? join(process.env.HOME!, ".codex"),
              "auth.json",
            ),
            auth,
          );
          chmodSync(auth, 0o600);
          const result = await promisify(execFile)(
            "codex",
            [
              "exec",
              "resume",
              codex.targetSessionId,
              "--ignore-user-config",
              "--skip-git-repo-check",
              "--json",
              "Repeat the previous assistant message verbatim and then add the marker LIVE_CODEX_RETURN. Use no tools.",
            ],
            {
              ...options,
              timeout: 60000,
              env: { ...options.env, CODEX_HOME: isolatedCodex },
            },
          );
          expect(result.stdout).toContain(returnedText);
          expect(result.stdout).toContain("LIVE_CODEX_RETURN");
        } else {
          appendFileSync(
            codex.sessionPath,
            JSON.stringify({
              timestamp: new Date(now + 2).toISOString(),
              type: "response_item",
              payload: {
                type: "message",
                role: "assistant",
                content: [
                  { type: "output_text", text: "Codex imported answer" },
                ],
              },
            }) + "\n",
          );
        }
        const sendBack = () =>
          returnCodexTurnsToOpenCode({
            registryPath: join(root, "registry.json"),
            codexSessionId: codex.targetSessionId,
            databasePath: path,
            version,
          });
        expect(await sendBack()).toBe(live ? 2 : 1);
        expect(await sendBack()).toBe(0);
        await promisify(execFile)(
          "opencode",
          [
            "run",
            "--print-logs",
            "--log-level",
            "debug",
            "--standalone",
            "--session",
            id,
            "--model",
            "fixture/test",
            "--format",
            "json",
            "Continue the original thread",
          ],
          options,
        ).catch((error) => {
          throw new Error(error.stderr || error.stdout || error.message);
        });
        expect(modelRequest).toContain("Original session retains this turn");
        expect(modelRequest).toContain("Continue the original thread");
        expect(modelRequest).toContain(
          live ? "LIVE_CODEX_RETURN" : returnedText,
        );
        const resumed = JSON.parse(
          opencode("session", "export", "--standalone", id),
        );
        expect(resumed.info.id).toBe(id);
        expect(JSON.stringify(resumed.messages)).toContain(
          "Offline continuation",
        );
        writeFileSync(exportPath, JSON.stringify(resumed));
        expect((await sync()).writes[0]?.appendedCount).toBeGreaterThan(0);
        expect((await sync()).writes[0]?.appendedCount).toBe(0);
        appendFileSync(
          codex.sessionPath,
          JSON.stringify({
            timestamp: new Date().toISOString(),
            type: "response_item",
            payload: {
              type: "message",
              role: "assistant",
              content: [{ type: "output_text", text: "Second Codex handoff" }],
            },
          }) + "\n",
        );
        expect(await sendBack()).toBe(1);
        expect(await sendBack()).toBe(0);
        expect(opencode("session", "export", "--standalone", id)).toContain(
          "Second Codex handoff",
        );
      } finally {
        provider.closeAllConnections();
        await new Promise<void>((resolve) => provider.close(() => resolve()));
        rmSync(root, { recursive: true, force: true });
      }
    }, 75000);
  },
);
