import { afterAll, beforeAll, expect, it } from "bun:test";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  describeToolInContainer,
  saveArtifacts,
} from "./support/in-container.js";
import { ScriptedMock } from "./support/mock.js";
import { createPiSandbox, runPi, type PiSandbox } from "./support/pi.js";

const PROMPT = "Say hello so the bridge extension has a turn to mirror.";
const FINAL = "Hello from the mock, mirrored by the bridge extension.";

let mock: ScriptedMock;
let pi: PiSandbox;

function jsonlUnder(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.name.endsWith(".jsonl")) out.push(path);
    }
  };
  walk(root);
  return out;
}

// The bridge ships its Pi extension as TypeScript source (no build step), and Pi
// loads it from the runtime directory `setup` copies out. A mirror session
// appearing in Codex or Claude Code after a real Pi turn proves Pi loaded the
// extension and that it ran against the copied core source.
describeToolInContainer(
  "pi",
  "real Pi loads the bridge extension from TypeScript source",
  () => {
    beforeAll(async () => {
      mock = await ScriptedMock.start();
      mock.reply(PROMPT, FINAL);
      pi = createPiSandbox(mock.openaiBaseUrl);
    });
    afterAll(async () => {
      saveArtifacts("pi-extension", pi.root);
      await mock.stop();
    });

    it("sets the bridge up, then mirrors a real Pi turn into Codex and Claude Code", async () => {
      Bun.spawnSync(["git", "init", "-q", pi.project]);
      const setup = Bun.spawnSync(
        ["bun", join(import.meta.dir, "support", "bridge-cli.ts"), "setup"],
        { env: { ...pi.env }, cwd: pi.project },
      );
      const setupOut = `${setup.stdout.toString()}${setup.stderr.toString()}`;
      expect(setup.exitCode, setupOut).toBe(0);
      const settings = JSON.parse(
        readFileSync(join(pi.agentDir, "settings.json"), "utf8"),
      ) as { packages?: string[] };
      expect(settings.packages?.some((p) => p.endsWith("packages/pi"))).toBe(
        true,
      );

      const result = await runPi(pi, PROMPT);
      writeFileSync(
        join(pi.root, "pi-run.txt"),
        `${result.code}\n${result.stdout}\n${result.stderr}`,
      );
      expect(result.code, result.stderr).toBe(0);
      expect(result.stdout).toContain(FINAL);

      // The extension syncs after the turn; give it a moment to write.
      const mirrored = () => [
        ...jsonlUnder(join(pi.homeDir, ".codex", "sessions")),
        ...jsonlUnder(join(pi.homeDir, ".claude", "projects")),
      ];
      for (let i = 0; i < 40 && mirrored().length === 0; i++) {
        await Bun.sleep(500);
      }
      expect(mirrored().length, result.stderr).toBeGreaterThan(0);
    }, 240_000);

    it("control: the same Pi turn without the bridge set up mirrors nothing", async () => {
      const bare = createPiSandbox(mock.openaiBaseUrl);
      const result = await runPi(bare, PROMPT);
      expect(result.code, result.stderr).toBe(0);
      await Bun.sleep(4000);
      expect([
        ...jsonlUnder(join(bare.homeDir, ".codex", "sessions")),
        ...jsonlUnder(join(bare.homeDir, ".claude", "projects")),
      ]).toEqual([]);
    }, 120_000);
  },
);
