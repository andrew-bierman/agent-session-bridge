import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** An isolated Codex: its own CODEX_HOME, working directory and environment. */
export interface CodexSandbox {
  root: string;
  codexHome: string;
  project: string;
  env: Record<string, string>;
}

export const CODEX_MODEL = "gpt-5.1-codex";

/**
 * Create an isolated Codex whose only model provider is the mock. Nothing here
 * reads a real home directory: HOME, CODEX_HOME and the project are fresh.
 */
export function createCodexSandbox(openaiBaseUrl: string): CodexSandbox {
  const root = mkdtempSync(join(tmpdir(), "asb-codex-"));
  const codexHome = join(root, "codex-home");
  const project = join(root, "project");
  mkdirSync(codexHome, { recursive: true });
  mkdirSync(project, { recursive: true });
  writeFileSync(
    join(codexHome, "config.toml"),
    [
      `model = "${CODEX_MODEL}"`,
      `model_provider = "mock"`,
      "",
      "[model_providers.mock]",
      `name = "Mock"`,
      `base_url = "${openaiBaseUrl}"`,
      `env_key = "MOCK_API_KEY"`,
      `wire_api = "responses"`,
      "",
    ].join("\n"),
  );
  return {
    root,
    codexHome,
    project,
    env: {
      PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
      HOME: join(root, "home"),
      TMPDIR: process.env.TMPDIR ?? tmpdir(),
      CODEX_HOME: codexHome,
      MOCK_API_KEY: "sk-aimock-codex",
      TERM: "dumb",
    },
  };
}

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Run `codex <args>` in the sandbox with a clean environment and a timeout. */
export async function runCodex(
  sandbox: CodexSandbox,
  args: string[],
  timeoutMs = 120_000,
): Promise<RunResult> {
  mkdirSync(sandbox.env.HOME!, { recursive: true });
  const child = Bun.spawn(["codex", ...args], {
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

export const execArgs = (project: string, prompt: string): string[] => [
  "exec",
  "--json",
  "--skip-git-repo-check",
  "--sandbox",
  "danger-full-access",
  "-C",
  project,
  prompt,
];

/** Every rollout under CODEX_HOME/sessions, sorted by path. */
export function findRollouts(codexHome: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (/^rollout-.*\.jsonl$/.test(entry.name)) out.push(path);
    }
  };
  walk(join(codexHome, "sessions"));
  return out.sort();
}

export interface RolloutLine {
  timestamp?: string;
  type: string;
  payload: Record<string, unknown>;
}

export function readRollout(path: string): RolloutLine[] {
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as RolloutLine);
}

/** Rows of Codex's thread index (the newest state_N.sqlite), via the sqlite3 CLI. */
export function threadRows(
  codexHome: string,
  columns = "id, cwd, preview, archived",
): Record<string, unknown>[] {
  const dbs = existsSync(codexHome)
    ? readdirSync(codexHome)
        .filter((f) => /^state_\d+\.sqlite$/.test(f))
        .sort()
    : [];
  const newest = dbs.at(-1);
  if (!newest) return [];
  const out = execFileSync(
    "sqlite3",
    ["-readonly", "-json", join(codexHome, newest), `SELECT ${columns} FROM threads ORDER BY id;`],
    { encoding: "utf8" },
  ).trim();
  return out ? (JSON.parse(out) as Record<string, unknown>[]) : [];
}
