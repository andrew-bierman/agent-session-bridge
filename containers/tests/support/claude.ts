import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { RunResult } from "./codex.js";

/** An isolated Claude Code: its own HOME, config directory and project. */
export interface ClaudeSandbox {
  root: string;
  /** HOME for the run; sessions live under `<homeDir>/.claude/projects/`. */
  homeDir: string;
  configDir: string;
  project: string;
  env: Record<string, string>;
}

/**
 * Create an isolated Claude Code whose only endpoint is the mock. Nothing
 * reads a real home directory, and background traffic is switched off.
 */
export function createClaudeSandbox(anthropicBaseUrl: string): ClaudeSandbox {
  const root = mkdtempSync(join(tmpdir(), "asb-claude-"));
  const homeDir = join(root, "home");
  const configDir = join(homeDir, ".claude");
  const project = join(root, "project");
  mkdirSync(configDir, { recursive: true });
  mkdirSync(project, { recursive: true });
  return {
    root,
    homeDir,
    configDir,
    project,
    env: {
      PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
      HOME: homeDir,
      TMPDIR: process.env.TMPDIR ?? tmpdir(),
      CLAUDE_CONFIG_DIR: configDir,
      ANTHROPIC_BASE_URL: anthropicBaseUrl,
      ANTHROPIC_API_KEY: "sk-aimock-claude",
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      DISABLE_AUTOUPDATER: "1",
      TERM: "dumb",
    },
  };
}

/** Run `claude <args>` in the sandbox with a clean environment and a timeout. */
export async function runClaude(
  sandbox: ClaudeSandbox,
  args: string[],
  timeoutMs = 120_000,
): Promise<RunResult> {
  const child = Bun.spawn(["claude", ...args], {
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

export const printArgs = (prompt: string): string[] => [
  "-p",
  "--output-format",
  "json",
  "--dangerously-skip-permissions",
  prompt,
];

export const resumeArgs = (sessionId: string, prompt: string): string[] => [
  "-p",
  "--output-format",
  "json",
  "--dangerously-skip-permissions",
  "--resume",
  sessionId,
  prompt,
];

/** Every session transcript under `<configDir>/projects`, sorted by path. */
export function findSessions(configDir: string): string[] {
  const out: string[] = [];
  const root = join(configDir, "projects");
  if (!existsSync(root)) return out;
  for (const project of readdirSync(root, { withFileTypes: true })) {
    if (!project.isDirectory()) continue;
    for (const file of readdirSync(join(root, project.name))) {
      if (file.endsWith(".jsonl")) out.push(join(root, project.name, file));
    }
  }
  return out.sort();
}

export interface SessionLine {
  type: string;
  uuid?: string;
  parentUuid?: string | null;
  sessionId?: string;
  message?: { role?: string; content?: unknown };
  [key: string]: unknown;
}

export function readSession(path: string): SessionLine[] {
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as SessionLine);
}

/** Content blocks of a session line, normalized to an array. */
export function blocksOf(
  line: SessionLine,
): { type: string; [k: string]: unknown }[] {
  const content = line.message?.content;
  if (Array.isArray(content)) return content as { type: string }[];
  return typeof content === "string" ? [{ type: "text", text: content }] : [];
}
