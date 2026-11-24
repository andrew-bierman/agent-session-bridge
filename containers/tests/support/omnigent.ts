import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Terminal, shellQuote } from "./terminal.js";

/** An isolated Omnigent: its own HOME, data directory, working dir and agent. */
export interface OmnigentSandbox {
  root: string;
  homeDir: string;
  dataDir: string;
  project: string;
  agentDir: string;
  env: Record<string, string>;
  session: string;
}

export interface MockUrls {
  openaiBaseUrl: string;
  anthropicBaseUrl: string;
}

const fixtureAgents = join(
  import.meta.dirname,
  "..",
  "..",
  "fixtures",
  "agents",
);

/**
 * Create an isolated Omnigent whose model providers are both the mock. Omnigent
 * bakes OPENAI_API_KEY / OPENAI_BASE_URL into its Codex executor and passes
 * ANTHROPIC_BASE_URL through to the Claude Agent SDK, so no real endpoint is
 * reachable. Everything it creates lives under the throwaway root.
 */
export function createOmnigentSandbox(
  urls: MockUrls,
  agent = "orchestrator",
): OmnigentSandbox {
  const root = mkdtempSync(join(tmpdir(), "asb-omni-"));
  const homeDir = join(root, "home");
  const dataDir = join(root, "omnigent-data");
  const project = join(root, "project");
  const agentDir = join(root, "agent");
  for (const dir of [homeDir, dataDir, project])
    mkdirSync(dir, { recursive: true });
  cpSync(join(fixtureAgents, agent), agentDir, { recursive: true });
  return {
    root,
    homeDir,
    dataDir,
    project,
    agentDir,
    session: `asb${Date.now().toString(36)}`,
    env: {
      PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
      HOME: homeDir,
      TMPDIR: process.env.TMPDIR ?? tmpdir(),
      OMNIGENT_DATA_DIR: dataDir,
      OPENAI_API_KEY: "sk-aimock-omnigent",
      OPENAI_BASE_URL: urls.openaiBaseUrl,
      ANTHROPIC_API_KEY: "sk-aimock-omnigent",
      ANTHROPIC_BASE_URL: urls.anthropicBaseUrl,
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      DISABLE_AUTOUPDATER: "1",
      TERM: "xterm-256color",
    },
  };
}

const terminalFor = (sandbox: OmnigentSandbox): Terminal =>
  Terminal.in(sandbox.root, sandbox.env, sandbox.project, sandbox.session);

/**
 * Start `omni <args>` in a detached terminal, since Omnigent's REPL needs a
 * TTY. The terminal stays open after the command exits so its screen can be
 * read; it shows `TERMINAL_EXITED` once `omni` is done.
 */
export function startOmnigent(sandbox: OmnigentSandbox, args: string[]): void {
  terminalFor(sandbox).start(`omni ${args.map(shellQuote).join(" ")}`);
}

export const screen = (sandbox: OmnigentSandbox): string =>
  terminalFor(sandbox).screen();

export async function waitFor(
  what: string,
  check: () => boolean | Promise<boolean>,
  timeoutMs: number,
  intervalMs = 500,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await Bun.sleep(intervalMs);
  }
  throw new Error(`Timed out after ${timeoutMs}ms waiting for ${what}`);
}

const repoRoot = join(import.meta.dirname, "..", "..", "..");

/** Run one of the repo's scripts against a sandbox's Omnigent data directory. */
async function runScript(
  sandbox: OmnigentSandbox,
  script: string,
  args: string[],
): Promise<{ code: number; stdout: string; stderr: string }> {
  const child = Bun.spawn(
    ["bun", script, "--omnigent-data", sandbox.dataDir, ...args],
    {
      cwd: repoRoot,
      env: {
        PATH: sandbox.env.PATH!,
        HOME: sandbox.homeDir,
        TMPDIR: sandbox.env.TMPDIR!,
      },
      stdout: "pipe",
      stderr: "pipe",
      stdin: "ignore",
    },
  );
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { code, stdout, stderr };
}

/** Run `scripts/omnigent-chat-export.ts` against a sandbox's chat.db. */
export const runExporter = (sandbox: OmnigentSandbox, args: string[]) =>
  runScript(sandbox, "scripts/omnigent-chat-export.ts", args);

/** Run `scripts/omnigent-codex-sync.ts` against a sandbox's native bridges. */
export const runCodexSync = (sandbox: OmnigentSandbox, args: string[]) =>
  runScript(sandbox, "scripts/omnigent-codex-sync.ts", args);

/** Stop the sandbox's terminal. Container-local; nothing on the host is touched. */
export function stopTerminal(sandbox: OmnigentSandbox): void {
  terminalFor(sandbox).kill();
}

/**
 * Give the sandbox's Omnigent a user-level Codex home, the way a user who has
 * logged in has one: Omnigent copies this config into each bridged session's
 * private CODEX_HOME and checks `auth.json` for a credential.
 */
export function installUserCodexHome(
  sandbox: OmnigentSandbox,
  openaiBaseUrl: string,
  model: string,
): void {
  const codexHome = join(sandbox.homeDir, ".codex");
  mkdirSync(codexHome, { recursive: true });
  writeFileSync(
    join(codexHome, "config.toml"),
    [
      `model = "${model}"`,
      `openai_base_url = "${openaiBaseUrl}"`,
      // The container is the sandbox; Codex's own (bubblewrap) needs user
      // namespaces the container does not grant.
      `sandbox_mode = "danger-full-access"`,
      `approval_policy = "never"`,
      "",
    ].join("\n"),
  );
  writeFileSync(
    join(codexHome, "auth.json"),
    JSON.stringify({ OPENAI_API_KEY: "sk-aimock-omnigent" }),
  );
}

/** Files under `root` whose text contains `needle`, skipping chat.db and sqlite files. */
export function filesContaining(root: string, needle: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (
        entry.isFile() &&
        !/\.(db|sqlite)(-wal|-shm)?$/.test(entry.name) &&
        statSync(path).size < 5_000_000 &&
        readFileSync(path, "utf8").includes(needle)
      ) {
        out.push(path);
      }
    }
  };
  walk(root);
  return out;
}
