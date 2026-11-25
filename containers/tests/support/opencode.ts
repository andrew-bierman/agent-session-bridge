import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { RunResult } from "./codex.js";

/** An isolated OpenCode 2.x: its own HOME and XDG dirs, and a project. */
export interface OpenCodeSandbox {
  root: string;
  homeDir: string;
  dataDir: string;
  project: string;
  env: Record<string, string>;
  /** OpenCode's SQLite database. */
  dbPath: string;
}

export const OPENCODE_MODEL = "openai/gpt-4o";

/**
 * Create an isolated OpenCode whose built-in OpenAI provider is pointed at the
 * mock through its documented `baseURL` option, with a dummy key. Update checks,
 * sharing and the models.dev refresh are off so it needs no network.
 */
export function createOpenCodeSandbox(openaiBaseUrl: string): OpenCodeSandbox {
  const root = mkdtempSync(join(tmpdir(), "asb-opencode-"));
  const homeDir = join(root, "home");
  const dataDir = join(homeDir, ".local", "share", "opencode");
  const project = join(root, "project");
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(project, { recursive: true });
  const config = {
    $schema: "https://opencode.ai/config.json",
    autoupdate: false,
    share: "disabled",
    provider: {
      openai: { options: { baseURL: openaiBaseUrl, apiKey: "sk-aimock-oc" } },
    },
  };
  return {
    root,
    homeDir,
    dataDir,
    project,
    dbPath: join(dataDir, "opencode.db"),
    env: {
      PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
      HOME: homeDir,
      TMPDIR: process.env.TMPDIR ?? tmpdir(),
      XDG_CONFIG_HOME: join(homeDir, ".config"),
      XDG_DATA_HOME: join(homeDir, ".local", "share"),
      XDG_CACHE_HOME: join(homeDir, ".cache"),
      OPENCODE_CONFIG_CONTENT: JSON.stringify(config),
      OPENCODE_DISABLE_AUTOUPDATE: "1",
      OPENCODE_DISABLE_MODELS_FETCH: "1",
      TERM: "dumb",
    },
  };
}

/** Run `opencode2 <args>` in the sandbox with a timeout. */
export async function runOpenCode(
  sandbox: OpenCodeSandbox,
  args: string[],
  timeoutMs = 120_000,
): Promise<RunResult> {
  const child = Bun.spawn(["opencode2", ...args], {
    cwd: sandbox.project,
    env: sandbox.env,
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
    timeout: timeoutMs,
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { code, stdout, stderr };
}
