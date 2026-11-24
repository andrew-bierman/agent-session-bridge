import { execFileSync } from "node:child_process";
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
      TMUX_TMPDIR: join(root, "tmux"),
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

const tmux = (sandbox: OmnigentSandbox, ...args: string[]): string => {
  mkdirSync(sandbox.env.TMUX_TMPDIR!, { recursive: true });
  try {
    return execFileSync("tmux", args, {
      env: sandbox.env,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    return String((error as { stdout?: string }).stdout ?? "");
  }
};

/**
 * Start `omni <args>` in a detached terminal, since Omnigent's REPL needs a
 * TTY. The terminal stays open after the command exits so its screen can be
 * read.
 */
export function startOmnigent(sandbox: OmnigentSandbox, args: string[]): void {
  const quoted = args.map((a) => `'${a.replaceAll("'", `'\\''`)}'`).join(" ");
  tmux(
    sandbox,
    "new-session",
    "-d",
    "-s",
    sandbox.session,
    "-x",
    "200",
    "-y",
    "50",
    "-c",
    sandbox.project,
    `omni ${quoted}; echo OMNI_EXITED; sleep 600`,
  );
}

export function screen(sandbox: OmnigentSandbox): string {
  return tmux(
    sandbox,
    "capture-pane",
    "-p",
    "-t",
    sandbox.session,
    "-S",
    "-200",
  );
}

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

export function chatDbPath(sandbox: OmnigentSandbox): string {
  return join(sandbox.dataDir, "chat.db");
}

export function writeJson(path: string, value: unknown): void {
  writeFileSync(path, JSON.stringify(value, null, 2));
}

export const hasChatDb = (sandbox: OmnigentSandbox): boolean =>
  existsSync(chatDbPath(sandbox));

export const readText = (path: string): string => readFileSync(path, "utf8");

const repoRoot = join(import.meta.dirname, "..", "..", "..");

/** Run `scripts/omnigent-chat-export.ts` against a sandbox's chat.db. */
export async function runExporter(
  sandbox: OmnigentSandbox,
  args: string[],
): Promise<{ code: number; stdout: string; stderr: string }> {
  const child = Bun.spawn(
    [
      "bun",
      "scripts/omnigent-chat-export.ts",
      "--omnigent-data",
      sandbox.dataDir,
      ...args,
    ],
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
