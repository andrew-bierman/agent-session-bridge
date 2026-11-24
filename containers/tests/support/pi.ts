import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { RunResult } from "./codex.js";

/** An isolated Pi: its own HOME, agent directory, and project. */
export interface PiSandbox {
  root: string;
  homeDir: string;
  agentDir: string;
  project: string;
  env: Record<string, string>;
}

export const PI_MODEL = "mock-model";

/**
 * Create an isolated Pi whose only provider is the mock, registered the way a
 * user adds any OpenAI-compatible endpoint: a `models.json` entry with a dummy
 * key. Startup network operations are off.
 */
export function createPiSandbox(openaiBaseUrl: string): PiSandbox {
  const root = mkdtempSync(join(tmpdir(), "asb-pi-"));
  const homeDir = join(root, "home");
  const agentDir = join(homeDir, ".pi", "agent");
  const project = join(root, "project");
  mkdirSync(agentDir, { recursive: true });
  mkdirSync(project, { recursive: true });
  writeFileSync(
    join(agentDir, "models.json"),
    JSON.stringify({
      providers: {
        mock: {
          baseUrl: openaiBaseUrl,
          api: "openai-completions",
          apiKey: "sk-aimock-pi",
          models: [{ id: PI_MODEL }],
        },
      },
    }),
  );
  return {
    root,
    homeDir,
    agentDir,
    project,
    env: {
      PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
      HOME: homeDir,
      TMPDIR: process.env.TMPDIR ?? tmpdir(),
      PI_CODING_AGENT_DIR: agentDir,
      PI_OFFLINE: "1",
      TERM: "dumb",
    },
  };
}

/** Run `pi -p "<prompt>"` against the mock in the sandbox. */
export async function runPi(
  sandbox: PiSandbox,
  prompt: string,
  timeoutMs = 120_000,
): Promise<RunResult> {
  const child = Bun.spawn(
    [
      "pi",
      "--print",
      "--offline",
      "--provider",
      "mock",
      "--model",
      PI_MODEL,
      prompt,
    ],
    {
      cwd: sandbox.project,
      env: sandbox.env,
      stdout: "pipe",
      stderr: "pipe",
      stdin: "ignore",
      timeout: timeoutMs,
    },
  );
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { code, stdout, stderr };
}
