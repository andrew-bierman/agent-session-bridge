#!/usr/bin/env node

import { constants as bufferConstants } from "node:buffer";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createWriteStream, existsSync, realpathSync } from "node:fs";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";

import {
  backfillCodexThreadIndex,
  createDefaultConfig,
  createOpenCodeSeed,
  seedLinkedSessionInOpenCode,
  readSeedSourceId,
  syncOpenCodeSession,
  findConversationByBridgeSessionId,
  findConversationByNativeSession,
  findConversationByProjectKey,
  getClaudeCodeProjectDir,
  getPiSessionDir,
  importLatestSessionToTarget,
  isProjectEnabled,
  listForeignSessionCandidates,
  loadBridgeConfig,
  loadSourceSessionSnapshot,
  loadOpenCodeDatabaseSnapshot,
  loadRegistry,
  saveRegistry,
  serializeBridgeConfig,
  setRepairState,
  syncSourceSessionToTargets,
  returnCodexTurnsToOpenCode,
  upsertConversation,
  hasCodexThreadIndexEntry,
  type BridgeConfig,
  type BridgeRegistry,
  type ToolName,
} from "../../core/src/index.js";

export interface CliDeps {
  load(): Promise<BridgeRegistry>;
  save(registry: BridgeRegistry): Promise<void>;
  stdout(line: string): void;
  cwd?: string;
  repoRoot?: string;
  homeDir?: string;
  readFile?: typeof fs.readFile;
  writeFile?: typeof fs.writeFile;
  mkdir?: typeof fs.mkdir;
  lstat?: typeof fs.lstat;
  unlink?: typeof fs.unlink;
  symlink?: typeof fs.symlink;
  rm?: typeof fs.rm;
  cp?: typeof fs.cp;
}

function hasFlag(args: string[], flag: string): boolean {
  return args.includes(flag);
}

function readOption(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

function withoutFlags(args: string[]): string[] {
  const result: string[] = [];

  for (let index = 0; index < args.length; index += 1) {
    const value = args[index]!;
    if (value.startsWith("--")) {
      if (
        value === "--cwd" ||
        value === "--tool" ||
        value === "--target-cwd" ||
        value === "--database"
      ) {
        index += 1;
      }
      continue;
    }
    result.push(value);
  }

  return result;
}

async function exportOpenCodeSession(
  id: string,
  path: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
): Promise<void> {
  const output = await fs.open(path, "wx", 0o600);
  try {
    execFileSync("opencode", ["session", "export", "--standalone", id], {
      cwd,
      env,
      timeout: 30000,
      stdio: ["ignore", output.fd, "pipe"],
    });
  } finally {
    await output.close();
  }
}

function resolveHomeDir(deps: CliDeps): string {
  return deps.homeDir ?? homedir();
}

function resolveCwd(deps: CliDeps, argv: string[]): string {
  return resolve(readOption(argv, "--cwd") ?? deps.cwd ?? process.cwd());
}

function resolveCwdAliases(cwd: string): string[] {
  const values = new Set([cwd]);
  try {
    values.add(realpathSync(cwd));
  } catch {}
  return [...values];
}

function conversationMatchesProject(
  conversation: BridgeRegistry["conversations"][number],
  cwd: string,
): boolean {
  const aliases = resolveCwdAliases(cwd);
  return aliases.some(
    (value) =>
      conversation.projectKey === value || conversation.canonicalCwd === value,
  );
}

function resolveRegistryPath(homeDir: string): string {
  return join(homeDir, ".agent-session-bridge", "registry.json");
}

function resolveConfigPath(homeDir: string): string {
  return join(homeDir, ".agent-session-bridge", "config.json");
}

function resolveHookStateDir(
  homeDir: string,
  tool: "claude-code" | "codex",
): string {
  return join(homeDir, ".agent-session-bridge", `${tool}-hooks`);
}

function parseTargetTools(argv: string[]): ToolName[] {
  const tool = readOption(argv, "--tool");
  if (tool === "pi" || tool === "claude" || tool === "codex") {
    return [tool];
  }
  return ["pi", "claude", "codex"];
}

function uniqueBy<T>(items: T[], key: (item: T) => string): T[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const value = key(item);
    if (seen.has(value)) {
      return false;
    }
    seen.add(value);
    return true;
  });
}

async function pathExists(
  path: string,
  deps: Pick<CliDeps, "lstat">,
): Promise<boolean> {
  const lstatImpl = deps.lstat ?? fs.lstat;
  try {
    await lstatImpl(path);
    return true;
  } catch (error) {
    const nodeError = error as NodeJS.ErrnoException;
    if (nodeError.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

function mergeEnabledProject(
  config: BridgeConfig,
  cwd: string,
  globalMode: boolean,
): BridgeConfig {
  const normalizedEnabled = globalMode
    ? []
    : uniqueBy([...config.enabledProjects, cwd], (value) => value);
  return {
    ...config,
    optIn: true,
    enabledProjects: normalizedEnabled,
    disabledProjects: config.disabledProjects.filter((value) => value !== cwd),
    directions: {
      ...config.directions,
      "pi->claude": true,
      "pi->codex": true,
      "claude->pi": true,
      "claude->codex": true,
      "codex->pi": true,
      "codex->claude": true,
    },
  };
}

async function loadExistingConfig(
  homeDir: string,
  deps: Pick<CliDeps, "readFile">,
): Promise<BridgeConfig> {
  return loadBridgeConfig(resolveConfigPath(homeDir), {
    readFile: deps.readFile ?? fs.readFile,
  });
}

async function saveBridgeConfig(
  homeDir: string,
  config: BridgeConfig,
  deps: Pick<CliDeps, "writeFile" | "mkdir">,
): Promise<string> {
  const writeFileImpl = deps.writeFile ?? fs.writeFile;
  const mkdirImpl = deps.mkdir ?? fs.mkdir;
  const configPath = resolveConfigPath(homeDir);
  await mkdirImpl(dirname(configPath), { recursive: true });
  await writeFileImpl(
    configPath,
    `${JSON.stringify(serializeBridgeConfig(config), null, 2)}\n`,
    "utf8",
  );
  return configPath;
}

function resolvePackageRoot(deps: CliDeps): string {
  if (deps.repoRoot) {
    return resolve(deps.repoRoot);
  }
  let current = dirname(fileURLToPath(import.meta.url));
  while (true) {
    if (
      existsSync(join(current, "packages", "pi", "package.json")) &&
      existsSync(join(current, "packages", "claude-code", "package.json")) &&
      existsSync(join(current, "packages", "codex", "package.json"))
    ) {
      return current;
    }
    const parent = dirname(current);
    if (parent === current) {
      return resolve(process.cwd());
    }
    current = parent;
  }
}

function resolveRuntimeRoot(homeDir: string): string {
  return join(homeDir, ".agent-session-bridge", "runtime");
}

function resolveRuntimePackageDir(
  runtimeRoot: string,
  packageName: "pi" | "claude-code" | "codex",
): string {
  return join(runtimeRoot, "packages", packageName);
}

function resolveClaudeHookCliPath(runtimeRoot: string): string {
  return join(
    resolveRuntimePackageDir(runtimeRoot, "claude-code"),
    "dist",
    "claude-code",
    "src",
    "hook-cli.js",
  );
}

function resolveCodexHookCliPath(runtimeRoot: string): string {
  return join(
    resolveRuntimePackageDir(runtimeRoot, "codex"),
    "dist",
    "codex",
    "src",
    "hook-cli.js",
  );
}

function resolvePiPackagePath(runtimeRoot: string): string {
  return resolveRuntimePackageDir(runtimeRoot, "pi");
}

function hookCommandExists(entries: unknown, command: string): boolean {
  if (!Array.isArray(entries)) {
    return false;
  }
  return entries.some((entry) => {
    if (typeof entry !== "object" || entry === null) {
      return false;
    }
    const hooks = Array.isArray((entry as { hooks?: unknown[] }).hooks)
      ? ((entry as { hooks?: unknown[] }).hooks ?? [])
      : [];
    return hooks.some(
      (hook) =>
        typeof hook === "object" &&
        hook !== null &&
        (hook as { command?: unknown }).command === command,
    );
  });
}

async function readJsonFile<T>(
  path: string,
  deps: Pick<CliDeps, "readFile">,
): Promise<T | null> {
  const readFileImpl = deps.readFile ?? fs.readFile;
  try {
    return JSON.parse(await readFileImpl(path, "utf8")) as T;
  } catch (error) {
    const nodeError = error as NodeJS.ErrnoException;
    if (nodeError.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

async function ensureSymlink(
  linkPath: string,
  targetPath: string,
  deps: Pick<CliDeps, "mkdir" | "lstat" | "unlink" | "symlink">,
): Promise<void> {
  const mkdirImpl = deps.mkdir ?? fs.mkdir;
  const lstatImpl = deps.lstat ?? fs.lstat;
  const unlinkImpl = deps.unlink ?? fs.unlink;
  const symlinkImpl = deps.symlink ?? fs.symlink;

  await mkdirImpl(dirname(linkPath), { recursive: true });

  try {
    const existing = await lstatImpl(linkPath);
    if (existing.isSymbolicLink()) {
      const currentTarget = await fs.readlink(linkPath);
      if (resolve(dirname(linkPath), currentTarget) === targetPath) {
        return;
      }
    }
    await unlinkImpl(linkPath);
  } catch (error) {
    const nodeError = error as NodeJS.ErrnoException;
    if (nodeError.code !== "ENOENT") {
      throw error;
    }
  }

  await symlinkImpl(targetPath, linkPath, "dir");
}

async function installRuntimeBundle(
  homeDir: string,
  packageRoot: string,
  deps: Pick<CliDeps, "mkdir" | "rm" | "cp" | "lstat">,
): Promise<string> {
  const runtimeRoot = resolveRuntimeRoot(homeDir);
  const mkdirImpl = deps.mkdir ?? fs.mkdir;
  const rmImpl = deps.rm ?? fs.rm;
  const cpImpl = deps.cp ?? fs.cp;

  await mkdirImpl(join(runtimeRoot, "packages"), { recursive: true });

  for (const packageName of ["pi", "claude-code", "codex"] as const) {
    const sourceDir = join(packageRoot, "packages", packageName);
    const targetDir = join(runtimeRoot, "packages", packageName);
    const sourcePackageJson = join(sourceDir, "package.json");
    const sourceDistDir = join(sourceDir, "dist");

    if (!(await pathExists(sourcePackageJson, deps))) {
      throw new Error(
        `Missing packaged asset: ${sourcePackageJson}. Run pnpm build before setup.`,
      );
    }
    if (!(await pathExists(sourceDistDir, deps))) {
      throw new Error(
        `Missing packaged asset: ${sourceDistDir}. Run pnpm build before setup.`,
      );
    }

    await rmImpl(targetDir, { force: true, recursive: true });
    await mkdirImpl(targetDir, { recursive: true });
    await cpImpl(sourcePackageJson, join(targetDir, "package.json"));
    await cpImpl(sourceDistDir, join(targetDir, "dist"), {
      recursive: true,
      force: true,
    });
  }

  return runtimeRoot;
}

function mergeHookArray(
  current: unknown,
  command: string,
  predicate?: (command: string) => boolean,
  hookConfig: Record<string, unknown> = {},
): Array<Record<string, unknown>> {
  const existing = (Array.isArray(current) ? current : [])
    .flatMap((entry) => {
      if (typeof entry !== "object" || entry === null) {
        return [];
      }

      const hookEntries = Array.isArray((entry as { hooks?: unknown[] }).hooks)
        ? ((entry as { hooks?: unknown[] }).hooks ?? [])
        : [];

      if (hookEntries.length === 0) {
        return [entry as Record<string, unknown>];
      }

      const retainedHooks = hookEntries.filter((hook) => {
        if (typeof hook !== "object" || hook === null) {
          return true;
        }
        const hookCommand = (hook as { command?: unknown }).command;
        return !(
          typeof hookCommand === "string" && predicate?.(hookCommand) === true
        );
      });

      if (retainedHooks.length === 0) {
        return [];
      }

      return [
        {
          ...(entry as Record<string, unknown>),
          hooks: retainedHooks,
        },
      ];
    })
    .filter(
      (entry): entry is Record<string, unknown> =>
        typeof entry === "object" && entry !== null,
    );
  const alreadyPresent = existing.some((entry) => {
    if (typeof entry !== "object" || entry === null) {
      return false;
    }
    const hookEntries = Array.isArray((entry as { hooks?: unknown[] }).hooks)
      ? ((entry as { hooks?: unknown[] }).hooks ?? [])
      : [];
    return hookEntries.some(
      (hook) =>
        typeof hook === "object" &&
        hook !== null &&
        (hook as { command?: unknown }).command === command,
    );
  });

  if (alreadyPresent) {
    return existing as Array<Record<string, unknown>>;
  }

  return [
    ...existing,
    {
      matcher: "",
      hooks: [
        {
          type: "command",
          command,
          ...hookConfig,
        },
      ],
    },
  ];
}

async function configureClaudeHooks(
  homeDir: string,
  runtimeRoot: string,
  deps: Pick<CliDeps, "readFile" | "writeFile" | "mkdir">,
): Promise<string> {
  const readFileImpl = deps.readFile ?? fs.readFile;
  const writeFileImpl = deps.writeFile ?? fs.writeFile;
  const mkdirImpl = deps.mkdir ?? fs.mkdir;
  const settingsPath = join(homeDir, ".claude", "settings.json");
  const hookCliPath = resolveClaudeHookCliPath(runtimeRoot);
  const isBridgeClaudeHook = (command: string): boolean =>
    command.includes("packages/claude-code") && command.includes("hook-cli.js");
  let settings: Record<string, unknown> = {};

  try {
    settings = JSON.parse(await readFileImpl(settingsPath, "utf8")) as Record<
      string,
      unknown
    >;
  } catch (error) {
    const nodeError = error as NodeJS.ErrnoException;
    if (nodeError.code !== "ENOENT") {
      throw error;
    }
  }

  const hooks =
    typeof settings.hooks === "object" && settings.hooks !== null
      ? ({ ...(settings.hooks as Record<string, unknown>) } satisfies Record<
          string,
          unknown
        >)
      : {};

  hooks.SessionStart = mergeHookArray(
    hooks.SessionStart,
    `node ${hookCliPath} session-start`,
    isBridgeClaudeHook,
    { async: true },
  );
  hooks.Stop = mergeHookArray(
    hooks.Stop,
    `node ${hookCliPath} stop`,
    isBridgeClaudeHook,
    { async: true },
  );
  settings.hooks = hooks;

  await mkdirImpl(dirname(settingsPath), { recursive: true });
  await writeFileImpl(
    `${settingsPath}`,
    `${JSON.stringify(settings, null, 2)}\n`,
    "utf8",
  );

  return settingsPath;
}

async function configureCodexHooks(
  homeDir: string,
  runtimeRoot: string,
  deps: Pick<CliDeps, "writeFile" | "mkdir">,
): Promise<string> {
  const writeFileImpl = deps.writeFile ?? fs.writeFile;
  const mkdirImpl = deps.mkdir ?? fs.mkdir;
  const hooksPath = join(homeDir, ".codex", "hooks.json");
  const hookCliPath = resolveCodexHookCliPath(runtimeRoot);

  const hooks = {
    hooks: {
      SessionStart: [
        {
          matcher: "startup|resume",
          hooks: [
            {
              type: "command",
              command: `node ${hookCliPath} session-start`,
              async: true,
            },
          ],
        },
      ],
      Stop: [
        {
          hooks: [
            {
              type: "command",
              command: `node ${hookCliPath} stop`,
              async: true,
            },
          ],
        },
      ],
    },
  };

  await mkdirImpl(dirname(hooksPath), { recursive: true });
  await writeFileImpl(hooksPath, `${JSON.stringify(hooks, null, 2)}\n`, "utf8");

  return hooksPath;
}

async function configurePiExtension(
  homeDir: string,
  runtimeRoot: string,
  deps: Pick<CliDeps, "readFile" | "writeFile" | "mkdir" | "rm">,
): Promise<string> {
  const readFileImpl = deps.readFile ?? fs.readFile;
  const writeFileImpl = deps.writeFile ?? fs.writeFile;
  const mkdirImpl = deps.mkdir ?? fs.mkdir;
  const rmImpl = deps.rm ?? fs.rm;
  const settingsPath = join(homeDir, ".pi", "agent", "settings.json");
  const packageSource = resolvePiPackagePath(runtimeRoot);
  const legacyExtensionPath = join(
    homeDir,
    ".pi",
    "agent",
    "extensions",
    "agent-session-bridge",
  );

  const isCurrentPackage = (value: string) => value === packageSource;
  const isStaleLocalPiPackage = (value: string) =>
    value.startsWith("/") &&
    !isCurrentPackage(value) &&
    (value.endsWith("/packages/pi") || value.endsWith("/pi"));

  let settings: Record<string, unknown> = {};

  try {
    settings = JSON.parse(await readFileImpl(settingsPath, "utf8")) as Record<
      string,
      unknown
    >;
  } catch (error) {
    const nodeError = error as NodeJS.ErrnoException;
    if (nodeError.code !== "ENOENT") {
      throw error;
    }
  }

  const packages = Array.isArray(settings.packages)
    ? settings.packages.filter(
        (value): value is string =>
          typeof value === "string" && !isStaleLocalPiPackage(value),
      )
    : [];

  if (!packages.includes(packageSource)) {
    packages.push(packageSource);
  }
  settings.packages = packages;

  await mkdirImpl(dirname(settingsPath), { recursive: true });
  await writeFileImpl(
    settingsPath,
    `${JSON.stringify(settings, null, 2)}\n`,
    "utf8",
  );
  await rmImpl(legacyExtensionPath, { force: true, recursive: true });

  return settingsPath;
}

async function writeBridgeConfig(
  homeDir: string,
  cwd: string,
  deps: Pick<CliDeps, "writeFile" | "mkdir">,
): Promise<string> {
  return saveBridgeConfig(
    homeDir,
    mergeEnabledProject(createDefaultConfig(), cwd, false),
    deps,
  );
}

interface ToolHealth {
  installed: boolean;
  details: string;
}

interface HookRunState {
  receivedAt?: string;
  error?: string;
}

function formatHealthLine(label: string, ok: boolean, details: string): string {
  return `${ok ? "OK" : "WARN"} ${label}: ${details}`;
}

async function readHookRunState(
  homeDir: string,
  tool: "claude-code" | "codex",
  deps: Pick<CliDeps, "readFile">,
): Promise<HookRunState> {
  const stateDir = resolveHookStateDir(homeDir, tool);
  const stop = await readJsonFile<{ receivedAt?: string }>(
    join(stateDir, "stop.json"),
    deps,
  );
  const error = await readJsonFile<{ error?: string }>(
    join(stateDir, "stop.error.json"),
    deps,
  );
  return {
    receivedAt: stop?.receivedAt,
    error: error?.error,
  };
}

async function inspectPiInstall(
  homeDir: string,
  runtimeRoot: string,
  deps: Pick<CliDeps, "readFile">,
): Promise<ToolHealth> {
  const settingsPath = join(homeDir, ".pi", "agent", "settings.json");
  const settings = await readJsonFile<{ packages?: string[] }>(
    settingsPath,
    deps,
  );
  const expected = resolvePiPackagePath(runtimeRoot);
  const installed = Boolean(settings?.packages?.includes(expected));
  return {
    installed,
    details: installed
      ? `package registered in ${settingsPath}`
      : `missing package registration in ${settingsPath}`,
  };
}

async function inspectClaudeInstall(
  homeDir: string,
  runtimeRoot: string,
  deps: Pick<CliDeps, "readFile">,
): Promise<ToolHealth> {
  const settingsPath = join(homeDir, ".claude", "settings.json");
  const settings = await readJsonFile<Record<string, unknown>>(
    settingsPath,
    deps,
  );
  const hooks =
    typeof settings?.hooks === "object" && settings?.hooks !== null
      ? (settings.hooks as Record<string, unknown>)
      : {};
  const hookCliPath = resolveClaudeHookCliPath(runtimeRoot);
  const startInstalled = hookCommandExists(
    hooks.SessionStart,
    `node ${hookCliPath} session-start`,
  );
  const stopInstalled = hookCommandExists(
    hooks.Stop,
    `node ${hookCliPath} stop`,
  );
  return {
    installed: startInstalled && stopInstalled,
    details:
      startInstalled && stopInstalled
        ? `hooks registered in ${settingsPath}`
        : `missing bridge hooks in ${settingsPath}`,
  };
}

async function inspectCodexInstall(
  homeDir: string,
  runtimeRoot: string,
  deps: Pick<CliDeps, "readFile">,
): Promise<ToolHealth> {
  const hooksPath = join(homeDir, ".codex", "hooks.json");
  const hooksFile = await readJsonFile<Record<string, unknown>>(
    hooksPath,
    deps,
  );
  const hooks =
    typeof hooksFile?.hooks === "object" && hooksFile?.hooks !== null
      ? (hooksFile.hooks as Record<string, unknown>)
      : {};
  const hookCliPath = resolveCodexHookCliPath(runtimeRoot);
  const startInstalled = hookCommandExists(
    hooks.SessionStart,
    `node ${hookCliPath} session-start`,
  );
  const stopInstalled = hookCommandExists(
    hooks.Stop,
    `node ${hookCliPath} stop`,
  );
  return {
    installed: startInstalled && stopInstalled,
    details:
      startInstalled && stopInstalled
        ? `hooks registered in ${hooksPath}`
        : `missing bridge hooks in ${hooksPath}`,
  };
}

function zeroUsageCost(): Record<string, unknown> {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    total: 0,
  };
}

function normalizeUsageValue(value: unknown): Record<string, unknown> {
  const source =
    typeof value === "object" && value !== null
      ? (value as Record<string, unknown>)
      : {};

  const numberAt = (...keys: string[]): number => {
    for (const key of keys) {
      const candidate = source[key];
      if (typeof candidate === "number" && Number.isFinite(candidate)) {
        return candidate;
      }
    }
    return 0;
  };

  const costSource =
    typeof source.cost === "object" && source.cost !== null
      ? (source.cost as Record<string, unknown>)
      : {};
  const numberInCost = (key: string): number =>
    typeof costSource[key] === "number" &&
    Number.isFinite(costSource[key] as number)
      ? (costSource[key] as number)
      : 0;

  const input = numberAt("input", "input_tokens");
  const output = numberAt("output", "output_tokens");
  const cacheRead = numberAt("cacheRead", "cache_read_input_tokens");
  const cacheWrite = numberAt("cacheWrite", "cache_creation_input_tokens");
  const totalTokens =
    numberAt("totalTokens", "total_tokens") ||
    input + output + cacheRead + cacheWrite;

  return {
    ...source,
    input,
    output,
    cacheRead,
    cacheWrite,
    totalTokens,
    cost: {
      ...zeroUsageCost(),
      input: numberInCost("input"),
      output: numberInCost("output"),
      cacheRead: numberInCost("cacheRead"),
      cacheWrite: numberInCost("cacheWrite"),
      total: numberInCost("total"),
    },
  };
}

const directiveLinePattern =
  /^::(?:git-[a-z-]+|automation-update|code-comment|archive)\{[^]*\}$/;

function sanitizeTextBlock(text: string): string {
  const stripped = text
    .split("\n")
    .filter((line) => {
      const trimmed = line.trim();
      if (!trimmed) {
        return true;
      }
      return !directiveLinePattern.test(trimmed);
    })
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  try {
    const parsed = JSON.parse(stripped) as Record<string, unknown>;
    if (
      parsed &&
      typeof parsed === "object" &&
      (parsed.type === "input_text" || parsed.type === "output_text") &&
      typeof parsed.text === "string"
    ) {
      return parsed.text;
    }
  } catch {}

  return stripped;
}

const metaPrefixes = [
  "<permissions instructions>",
  "<app-context>",
  "<collaboration_mode>",
  "<apps_instructions>",
  "<skills_instructions>",
  "<plugins_instructions>",
  "# AGENTS.md instructions for ",
  "<environment_context>",
  "<turn_aborted>",
  "When you write or edit a git commit message, ensure the message ends with this trailer exactly once:",
];

function sanitizeMessageContent(content: unknown): {
  nextContent: unknown;
  textParts: string[];
  touched: boolean;
} {
  if (typeof content === "string") {
    const sanitized = sanitizeTextBlock(content);
    return {
      nextContent: sanitized,
      textParts: sanitized ? [sanitized] : [],
      touched: sanitized !== content,
    };
  }

  if (!Array.isArray(content)) {
    return { nextContent: content, textParts: [], touched: false };
  }

  let touched = false;
  const nextItems = content.flatMap((item) => {
    if (typeof item !== "object" || item === null) {
      return [item];
    }
    const record = item as Record<string, unknown>;
    if (record.type === "text" && typeof record.text === "string") {
      const raw = record.text;
      if (raw.trim() === "<image>" || raw.trim() === "</image>") {
        touched = true;
        return [];
      }
      const sanitized = sanitizeTextBlock(raw);
      if (!sanitized) {
        touched = true;
        return [];
      }
      if (sanitized !== raw) {
        touched = true;
      }
      return [{ ...record, text: sanitized }];
    }
    return [item];
  });

  const textParts = nextItems.flatMap((item) =>
    typeof item === "object" &&
    item !== null &&
    (item as { type?: unknown }).type === "text" &&
    typeof (item as { text?: unknown }).text === "string"
      ? [(item as { text: string }).text]
      : [],
  );
  return {
    nextContent: nextItems,
    textParts,
    touched,
  };
}

function isMetaTextParts(parts: string[]): boolean {
  if (parts.length === 0) {
    return false;
  }
  const joined = parts.join("\n").trimStart();
  return metaPrefixes.some((prefix) => joined.startsWith(prefix));
}

async function repairPiSessionsForProject(
  cwd: string,
  homeDir: string,
  deps: Pick<CliDeps, "readFile" | "writeFile" | "mkdir" | "lstat">,
): Promise<{
  filesTouched: number;
  filesScanned: number;
  entriesRemoved: number;
  assistantEntriesPatched: number;
}> {
  const dir = getPiSessionDir(cwd, homeDir);
  if (!(await pathExists(dir, deps))) {
    return {
      filesTouched: 0,
      filesScanned: 0,
      entriesRemoved: 0,
      assistantEntriesPatched: 0,
    };
  }

  const files = (await fs.readdir(dir))
    .filter((name) => name.endsWith(".jsonl"))
    .sort();
  let filesTouched = 0;
  let entriesRemoved = 0;
  let assistantEntriesPatched = 0;

  for (const name of files) {
    const path = join(dir, name);
    const raw = await (deps.readFile ?? fs.readFile)(path, "utf8");
    const lines = raw
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    if (lines.length === 0) {
      continue;
    }
    const [header, ...rest] = lines;
    let fileTouched = false;
    const sanitizedEntries = rest.map((entry) => {
      if (entry.type !== "message") {
        return entry;
      }
      const message =
        typeof entry.message === "object" && entry.message !== null
          ? ({ ...(entry.message as Record<string, unknown>) } satisfies Record<
              string,
              unknown
            >)
          : undefined;
      if (!message) {
        return entry;
      }
      const { nextContent, textParts, touched } = sanitizeMessageContent(
        message.content,
      );
      if (touched) {
        fileTouched = true;
      }
      const nextMessage: Record<string, unknown> = {
        ...message,
        content: nextContent,
      };
      const nextEntry: Record<string, unknown> = {
        ...entry,
        message: nextMessage,
      };
      if (message.role === "assistant") {
        const nextUsage = normalizeUsageValue(message.usage);
        if (JSON.stringify(nextUsage) !== JSON.stringify(message.usage ?? {})) {
          assistantEntriesPatched += 1;
          fileTouched = true;
        }
        nextEntry.message = {
          ...(nextEntry.message as Record<string, unknown>),
          usage: nextUsage,
          provider:
            typeof message.provider === "string"
              ? message.provider
              : "openai-codex",
          model: typeof message.model === "string" ? message.model : "gpt-5.4",
        };
      }
      return {
        ...nextEntry,
        __userTextParts: Array.isArray(textParts) ? textParts : [],
      } as Record<string, unknown>;
    });

    let firstMeaningfulIndex = -1;
    for (let index = 0; index < sanitizedEntries.length; index += 1) {
      const entry = sanitizedEntries[index]!;
      const message =
        typeof entry.message === "object" && entry.message !== null
          ? (entry.message as Record<string, unknown>)
          : null;
      if (message?.role !== "user") {
        continue;
      }
      const parts = Array.isArray(entry.__userTextParts)
        ? (entry.__userTextParts as string[])
            .map((part) => part.trim())
            .filter(Boolean)
        : [];
      if (parts.length > 0 && !isMetaTextParts(parts)) {
        firstMeaningfulIndex = index;
        break;
      }
    }

    const keptEntries = sanitizedEntries.filter((entry, index) => {
      const message =
        typeof entry.message === "object" && entry.message !== null
          ? (entry.message as Record<string, unknown>)
          : null;
      if (message?.role !== "user") {
        return true;
      }
      const parts = Array.isArray(entry.__userTextParts)
        ? (entry.__userTextParts as string[])
            .map((part) => part.trim())
            .filter(Boolean)
        : [];
      const beforeMeaningful =
        firstMeaningfulIndex === -1 || index < firstMeaningfulIndex;
      const metaOrEmpty = parts.length === 0 || isMetaTextParts(parts);
      if (beforeMeaningful && metaOrEmpty) {
        entriesRemoved += 1;
        fileTouched = true;
        return false;
      }
      return true;
    });

    let previousId: string | null = null;
    for (const entry of keptEntries) {
      delete entry.__userTextParts;
      if (entry.type === "message") {
        const nextParent = previousId;
        if (entry.parentId !== nextParent) {
          fileTouched = true;
          entry.parentId = nextParent;
        }
        previousId = typeof entry.id === "string" ? entry.id : previousId;
      }
    }

    if (!fileTouched) {
      continue;
    }

    filesTouched += 1;
    await (deps.mkdir ?? fs.mkdir)(dirname(path), { recursive: true });
    await (deps.writeFile ?? fs.writeFile)(
      path,
      `${[header, ...keptEntries].map((entry) => JSON.stringify(entry)).join("\n")}\n`,
      "utf8",
    );
  }

  return {
    filesTouched,
    filesScanned: files.length,
    entriesRemoved,
    assistantEntriesPatched,
  };
}

async function repairClaudeSessionsForProject(
  cwd: string,
  homeDir: string,
  deps: Pick<CliDeps, "readFile" | "writeFile" | "mkdir" | "lstat">,
): Promise<{
  filesTouched: number;
  filesScanned: number;
  thinkingBlocksRemoved: number;
}> {
  const dir = getClaudeCodeProjectDir(cwd, homeDir);
  if (!(await pathExists(dir, deps))) {
    return {
      filesTouched: 0,
      filesScanned: 0,
      thinkingBlocksRemoved: 0,
    };
  }

  const files = (await fs.readdir(dir))
    .filter((name) => name.endsWith(".jsonl"))
    .sort();
  let filesTouched = 0;
  let thinkingBlocksRemoved = 0;

  for (const name of files) {
    const path = join(dir, name);
    const raw = await (deps.readFile ?? fs.readFile)(path, "utf8");
    const lines = raw
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    let fileTouched = false;

    const sanitizedLines = lines.map((line) => {
      if (
        line.type !== "assistant" ||
        typeof line.message !== "object" ||
        line.message === null
      ) {
        return line;
      }

      const message = {
        ...(line.message as Record<string, unknown>),
      } satisfies Record<string, unknown>;

      if (!Array.isArray(message.content)) {
        return line;
      }

      const nextContent = message.content.filter((item) => {
        if (
          typeof item === "object" &&
          item !== null &&
          (item as { type?: unknown }).type === "thinking"
        ) {
          const thinkingValue = (item as { thinking?: unknown }).thinking;
          if (
            typeof thinkingValue !== "string" ||
            thinkingValue.trim().length === 0
          ) {
            thinkingBlocksRemoved += 1;
            fileTouched = true;
            return false;
          }
          if ("signature" in (item as Record<string, unknown>)) {
            delete (item as Record<string, unknown>).signature;
            fileTouched = true;
          }
        }
        return true;
      });

      if (!fileTouched) {
        return line;
      }

      return {
        ...line,
        message: {
          ...message,
          content: nextContent,
        },
      };
    });

    if (!fileTouched) {
      continue;
    }

    filesTouched += 1;
    await (deps.mkdir ?? fs.mkdir)(dirname(path), { recursive: true });
    await (deps.writeFile ?? fs.writeFile)(
      path,
      `${sanitizedLines.map((line) => JSON.stringify(line)).join("\n")}\n`,
      "utf8",
    );
  }

  return {
    filesTouched,
    filesScanned: files.length,
    thinkingBlocksRemoved,
  };
}

async function inspectCodexMirrorIndexForProject(
  cwd: string,
  registry: BridgeRegistry,
  homeDir: string,
): Promise<{
  mirrorsScanned: number;
  missingRows: number;
  invalidThreadIds: number;
}> {
  const conversations = registry.conversations.filter((conversation) =>
    conversationMatchesProject(conversation, cwd),
  );

  let mirrorsScanned = 0;
  let missingRows = 0;
  let invalidThreadIds = 0;

  for (const conversation of conversations) {
    const codexMirror = conversation.mirrors.codex;
    if (!codexMirror) {
      continue;
    }

    mirrorsScanned += 1;
    if (
      !/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        codexMirror.nativeId,
      )
    ) {
      invalidThreadIds += 1;
      continue;
    }

    const hasRow = await hasCodexThreadIndexEntry(
      homeDir,
      codexMirror.nativeId,
    );
    if (hasRow) {
      continue;
    }
    missingRows += 1;
  }

  return {
    mirrorsScanned,
    missingRows,
    invalidThreadIds,
  };
}

async function repairCodexMirrorIndexForProject(
  cwd: string,
  registry: BridgeRegistry,
  homeDir: string,
): Promise<{
  mirrorsScanned: number;
  rowsIndexed: number;
  invalidThreadIds: number;
  missingRollouts: number;
}> {
  const conversations = registry.conversations.filter((conversation) =>
    conversationMatchesProject(conversation, cwd),
  );

  let mirrorsScanned = 0;
  let rowsIndexed = 0;
  let invalidThreadIds = 0;
  let missingRollouts = 0;

  for (const conversation of conversations) {
    const codexMirror = conversation.mirrors.codex;
    if (!codexMirror) {
      continue;
    }

    mirrorsScanned += 1;

    const hadRow = await hasCodexThreadIndexEntry(
      homeDir,
      codexMirror.nativeId,
    );
    const result = await backfillCodexThreadIndex({
      homeDir,
      threadId: codexMirror.nativeId,
      rolloutPath: codexMirror.sessionPath,
      cwd: conversation.canonicalCwd,
    });

    if (result.reason === "invalid-thread-id") {
      invalidThreadIds += 1;
      continue;
    }

    if (result.reason === "missing-rollout") {
      missingRollouts += 1;
      continue;
    }

    if (!hadRow && result.indexed) {
      rowsIndexed += 1;
    }
  }

  return {
    mirrorsScanned,
    rowsIndexed,
    invalidThreadIds,
    missingRollouts,
  };
}

export async function runCli(argv: string[], deps: CliDeps): Promise<number> {
  const [command, ...restWithFlags] = argv;
  const rest = withoutFlags(restWithFlags);
  const dryRun = hasFlag(restWithFlags, "--dry-run");
  const globalMode = hasFlag(restWithFlags, "--global");
  const importMode = hasFlag(restWithFlags, "--all") ? "--all" : "--latest";
  const registry = await deps.load();
  const homeDir = resolveHomeDir(deps);
  const cwd = resolveCwd(deps, restWithFlags);
  const packageRoot = resolvePackageRoot(deps);
  const runtimeRoot = resolveRuntimeRoot(homeDir);
  const targetTools = parseTargetTools(restWithFlags);

  if (!command || command === "list") {
    for (const conversation of registry.conversations) {
      deps.stdout(
        `${conversation.bridgeSessionId} ${conversation.projectKey} ${conversation.status}`,
      );
    }
    return 0;
  }

  if (command === "setup") {
    const nextConfig = mergeEnabledProject(
      await loadExistingConfig(homeDir, deps),
      cwd,
      globalMode,
    );
    if (!dryRun) {
      await installRuntimeBundle(homeDir, packageRoot, deps);
      await saveBridgeConfig(homeDir, nextConfig, deps);
      await configureClaudeHooks(homeDir, runtimeRoot, deps);
      await configureCodexHooks(homeDir, runtimeRoot, deps);
      await configurePiExtension(homeDir, runtimeRoot, deps);
    }

    deps.stdout(
      `Agent Session Bridge setup ${dryRun ? "(dry-run) " : ""}complete.`,
    );
    deps.stdout(`Project scope: ${globalMode ? "global" : cwd}`);
    deps.stdout(`Config: ${resolveConfigPath(homeDir)}`);
    deps.stdout(`Runtime: ${runtimeRoot}`);
    deps.stdout(`Pi: ${join(homeDir, ".pi", "agent", "settings.json")}`);
    deps.stdout(`Claude Code: ${join(homeDir, ".claude", "settings.json")}`);
    deps.stdout(`Codex: ${join(homeDir, ".codex", "hooks.json")}`);
    deps.stdout(
      "Next steps: restart Pi, Claude Code, and Codex so they reload their integration settings.",
    );
    return 0;
  }

  if (command === "enable") {
    const nextConfig = mergeEnabledProject(
      await loadExistingConfig(homeDir, deps),
      cwd,
      globalMode,
    );
    if (!dryRun) {
      await saveBridgeConfig(homeDir, nextConfig, deps);
    }
    deps.stdout(
      `Bridge sync ${dryRun ? "would be enabled" : "enabled"} for ${
        globalMode ? "all projects" : cwd
      }.`,
    );
    deps.stdout(`Config: ${resolveConfigPath(homeDir)}`);
    return 0;
  }

  if (command === "doctor") {
    const config = await loadExistingConfig(homeDir, deps);
    const pi = await inspectPiInstall(homeDir, runtimeRoot, deps);
    const claude = await inspectClaudeInstall(homeDir, runtimeRoot, deps);
    const codex = await inspectCodexInstall(homeDir, runtimeRoot, deps);
    const claudeState = await readHookRunState(homeDir, "claude-code", deps);
    const codexState = await readHookRunState(homeDir, "codex", deps);
    const conversations = registry.conversations.filter((conversation) =>
      conversationMatchesProject(conversation, cwd),
    );
    const codexIndex = await inspectCodexMirrorIndexForProject(
      cwd,
      registry,
      homeDir,
    );
    const projectEnabled = isProjectEnabled(config, cwd);

    deps.stdout(`Doctor report for ${cwd}`);
    deps.stdout(
      formatHealthLine(
        "config",
        config.optIn,
        config.optIn ? "opt-in enabled" : "opt-in disabled",
      ),
    );
    deps.stdout(
      formatHealthLine(
        "project",
        projectEnabled,
        projectEnabled
          ? config.enabledProjects.length === 0
            ? "sync enabled globally"
            : "sync enabled for this project"
          : "project not enabled for sync",
      ),
    );
    deps.stdout(formatHealthLine("pi", pi.installed, pi.details));
    deps.stdout(formatHealthLine("claude", claude.installed, claude.details));
    deps.stdout(formatHealthLine("codex", codex.installed, codex.details));
    deps.stdout(
      formatHealthLine(
        "claude sync",
        Boolean(claudeState.receivedAt) && !claudeState.error,
        claudeState.error
          ? `last hook error: ${claudeState.error}`
          : claudeState.receivedAt
            ? `last stop hook: ${claudeState.receivedAt}`
            : "no stop hook run recorded yet",
      ),
    );
    deps.stdout(
      formatHealthLine(
        "codex sync",
        Boolean(codexState.receivedAt) && !codexState.error,
        codexState.error
          ? `last hook error: ${codexState.error}`
          : codexState.receivedAt
            ? `last stop hook: ${codexState.receivedAt}`
            : "no stop hook run recorded yet",
      ),
    );
    deps.stdout(
      formatHealthLine(
        "codex index",
        codexIndex.missingRows === 0 && codexIndex.invalidThreadIds === 0,
        codexIndex.mirrorsScanned === 0
          ? "no Codex mirrors linked to this project"
          : codexIndex.missingRows === 0 && codexIndex.invalidThreadIds === 0
            ? `all ${codexIndex.mirrorsScanned} Codex mirrors are visible to Codex app-server`
            : `${codexIndex.missingRows} mirrors missing threads rows, ${codexIndex.invalidThreadIds} mirrors use legacy non-resumable ids`,
      ),
    );
    deps.stdout(
      `Registry: ${conversations.length} conversation${conversations.length === 1 ? "" : "s"} linked to this project.`,
    );
    return pi.installed &&
      claude.installed &&
      codex.installed &&
      projectEnabled &&
      codexIndex.missingRows === 0 &&
      codexIndex.invalidThreadIds === 0
      ? 0
      : 1;
  }

  if (command === "repair") {
    const [bridgeSessionId] = rest;
    let conversation = bridgeSessionId
      ? findConversationByBridgeSessionId(registry, bridgeSessionId)
      : undefined;
    if (!conversation) {
      conversation = registry.conversations.find((item) =>
        conversationMatchesProject(item, cwd),
      );
    }

    if (!dryRun) {
      const piSummary = await repairPiSessionsForProject(cwd, homeDir, deps);
      const claudeSummary = await repairClaudeSessionsForProject(
        cwd,
        homeDir,
        deps,
      );
      const codexSummary = await repairCodexMirrorIndexForProject(
        cwd,
        registry,
        homeDir,
      );
      if (conversation) {
        const updated = upsertConversation(
          registry,
          setRepairState(conversation, {
            status: "idle",
            reason:
              piSummary.filesTouched > 0 ||
              claudeSummary.filesTouched > 0 ||
              codexSummary.rowsIndexed > 0
                ? `repaired ${piSummary.filesTouched} Pi, ${claudeSummary.filesTouched} Claude, and reindexed ${codexSummary.rowsIndexed} Codex mirrors`
                : "repair scan found nothing to change",
            updatedAt: new Date().toISOString(),
          }),
        );
        await deps.save(updated);
      }
      deps.stdout(
        `repair complete: scanned ${piSummary.filesScanned} Pi session files, ${claudeSummary.filesScanned} Claude session files, and ${codexSummary.mirrorsScanned} Codex mirrors; touched ${piSummary.filesTouched} Pi and ${claudeSummary.filesTouched} Claude; reindexed ${codexSummary.rowsIndexed} Codex mirrors; removed ${piSummary.entriesRemoved} bad Pi title entries; patched ${piSummary.assistantEntriesPatched} Pi assistant messages; removed ${claudeSummary.thinkingBlocksRemoved} empty Claude thinking blocks; found ${codexSummary.invalidThreadIds} Codex mirrors with legacy non-resumable ids and ${codexSummary.missingRollouts} missing rollout files`,
      );
      return 0;
    }

    deps.stdout(
      `repair would scan Pi, Claude, and Codex mirror index state for ${cwd}`,
    );
    return 0;
  }

  if (command === "seed-opencode") {
    const [tool, ...paths] = rest;
    const allowIncompleteTools = hasFlag(
      restWithFlags,
      "--allow-incomplete-tools",
    );
    const batch = hasFlag(restWithFlags, "--database");
    const fallback = readOption(restWithFlags, "--target-cwd");
    const fallbackFlag = hasFlag(restWithFlags, "--target-cwd");
    const batchDatabase = readOption(restWithFlags, "--database");
    if (
      (tool !== "codex" && tool !== "claude" && tool !== "pi") ||
      (batch && (dryRun || !batchDatabase || batchDatabase.startsWith("--"))) ||
      (fallbackFlag && (!batch || !fallback || fallback.startsWith("--"))) ||
      paths.length === 0 ||
      (!dryRun && !batch && paths.length !== 2) ||
      restWithFlags.length !==
        rest.length +
          (dryRun ? 1 : batch ? 2 : 0) +
          (fallbackFlag ? 2 : 0) +
          (allowIncompleteTools ? 1 : 0)
    ) {
      throw new Error(
        "Usage: seed-opencode <codex|claude|pi> <transcript> <database>, seed-opencode <codex|claude|pi> <transcript>... --database <database> [--target-cwd <fallback directory>], or seed-opencode <codex|claude|pi> <transcript>... --dry-run",
      );
    }
    const project = await fs.realpath(cwd);
    const sourceIds = new Map<string, string>();
    const conflictingIds = new Set<string>();
    const firstPaths = new Map<string, string>();
    for (const path of dryRun || batch ? paths : []) {
      try {
        const canonical = await fs.realpath(resolve(cwd, path));
        const id = await readSeedSourceId(tool, canonical);
        if (!id) continue;
        const first = firstPaths.get(id);
        if (first && first !== canonical) conflictingIds.add(id);
        firstPaths.set(id, canonical);
        sourceIds.set(path, id);
      } catch {
        // The seed pass reports unreadable and malformed transcripts per path.
      }
    }
    if (dryRun) {
      let rejected = 0;
      for (const path of paths) {
        try {
          const id = sourceIds.get(path);
          if (id && conflictingIds.has(id))
            throw new Error(
              "Multiple source files claim the same native session ID",
            );
          const bundle = await createOpenCodeSeed(
            tool,
            resolve(cwd, path),
            project,
            allowIncompleteTools,
          );
          deps.stdout(
            `${path}: ${bundle.info.id}, ${bundle.messages.length} messages eligible for import`,
          );
        } catch (error) {
          rejected += 1;
          deps.stdout(`${path}: rejected (${(error as Error).message})`);
        }
      }
      deps.stdout(
        `dry-run: ${paths.length - rejected} validated, ${rejected} rejected; no writes`,
      );
      return rejected ? 1 : 0;
    }
    const databasePath = await fs.realpath(
      resolve(cwd, batchDatabase ?? paths[1]!),
    );
    const fallbackCwd = fallback
      ? await fs.realpath(resolve(cwd, fallback))
      : undefined;
    const env = { ...process.env, OPENCODE_DB: databasePath };
    const opencode = (args: string[], directory = cwd) =>
      execFileSync("opencode", args, {
        cwd: directory,
        env,
        encoding: "utf8",
        timeout: 30000,
        maxBuffer: 32 * 1024 * 1024,
      });
    const version = opencode(["--version"])
      .trim()
      .replace(/^opencode v/, "");
    if (version !== "2.3.0" && version !== "2.3.2")
      throw new Error("Unsupported OpenCode version");

    const importVerified = async (
      bundle: Awaited<ReturnType<typeof createOpenCodeSeed>>,
      alreadyLinked: boolean,
    ) => {
      const verifyStoredRows = async () => {
        const { verifyOpenCodeSeedRows } =
          await import("../../core/src/opencode-store.js");
        if (
          !verifyOpenCodeSeedRows(
            databasePath,
            version,
            bundle.info.id,
            bundle.info.location.directory,
            bundle.messages,
          )
        ) {
          throw new Error(
            "OpenCode mirror differs from the source; no existing history was overwritten",
          );
        }
      };
      if (alreadyLinked) {
        await verifyStoredRows();
        return;
      }
      const directory = await fs.mkdtemp(
        join(tmpdir(), "bridge-opencode-seed-"),
      );
      try {
        const path = join(directory, "session.json");
        await pipeline(
          (function* () {
            yield `{"info":${JSON.stringify(bundle.info)},"messages":[`;
            for (const [index, message] of bundle.messages.entries())
              yield (index ? "," : "") + JSON.stringify(message);
            yield "]}";
          })(),
          createWriteStream(path, { mode: 0o600, flags: "wx" }),
        );
        opencode(
          ["session", "import", "--standalone", path],
          bundle.info.location.directory,
        );
        const exportPath = join(directory, "verified.json");
        await exportOpenCodeSession(
          bundle.info.id,
          exportPath,
          bundle.info.location.directory,
          env,
        );
        if (
          (await fs.stat(exportPath)).size >= bufferConstants.MAX_STRING_LENGTH
        ) {
          await verifyStoredRows();
          return;
        }
        const actual = JSON.parse(await fs.readFile(exportPath, "utf8"));
        if (
          actual.info?.id !== bundle.info.id ||
          actual.info?.location?.directory !== bundle.info.location.directory ||
          !Array.isArray(actual.messages) ||
          actual.messages.length < bundle.messages.length ||
          bundle.messages.some((message, i) => {
            const existing = actual.messages[i];
            return (
              existing?.id !== message.id ||
              existing.type !== message.type ||
              existing.time?.created !== message.time.created ||
              (message.type === "user"
                ? existing.text !== message.text
                : JSON.stringify(existing.content) !==
                  JSON.stringify(message.content))
            );
          })
        )
          throw new Error(
            "OpenCode mirror differs from the source; no existing history was overwritten",
          );
      } finally {
        await fs.rm(directory, { force: true, recursive: true });
      }
    };
    const seed = async (path: string, expectedSourceId?: string) => {
      const bundle = await seedLinkedSessionInOpenCode({
        tool,
        expectedSourceId,
        sourcePath: await fs.realpath(resolve(cwd, path)),
        cwd: batch ? undefined : project,
        fallbackCwd,
        allowIncompleteTools,
        databasePath,
        registryPath: resolveRegistryPath(homeDir),
        importVerified,
      });
      return `OpenCode ${bundle.info.id}: verified ${bundle.messages.length} seeded messages`;
    };
    if (!batch) {
      deps.stdout(await seed(paths[0]!));
      return 0;
    }
    let rejected = 0;
    for (const path of paths) {
      try {
        const id = sourceIds.get(path);
        if (id && conflictingIds.has(id))
          throw new Error(
            "Multiple source files claim the same native session ID",
          );
        deps.stdout(`${path}: ${await seed(path, id)}`);
      } catch (error) {
        rejected += 1;
        deps.stdout(`${path}: rejected (${(error as Error).message})`);
      }
    }
    deps.stdout(
      `${paths.length - rejected} imported or verified, ${rejected} rejected`,
    );
    return rejected ? 1 : 0;
  }

  if (command === "sync-opencode") {
    const all = hasFlag(restWithFlags, "--all");
    const [id, second] = rest;
    const database = all ? id : second;
    if (
      !database ||
      (!all && (!id || !/^ses_[a-zA-Z0-9]+$/.test(id))) ||
      rest.length !== (all ? 1 : 2) ||
      restWithFlags.length !== 2
    ) {
      throw new Error(
        "Usage: sync-opencode <OpenCode session ID> <database>, or sync-opencode --all <database>",
      );
    }
    const databasePath = await fs.realpath(resolve(cwd, database));
    const version = execFileSync("opencode", ["--version"], {
      encoding: "utf8",
      timeout: 5000,
    })
      .trim()
      .replace(/^opencode v/, "");
    if (version !== "2.3.0" && version !== "2.3.2")
      throw new Error("Unsupported OpenCode version");
    const sync = async (id: string) => {
      const { tool, write, returned } = await syncOpenCodeSession({
        registryPath: resolveRegistryPath(homeDir),
        homeDir,
        databasePath,
        version,
        sessionId: id,
      });
      const label = { codex: "Codex", claude: "Claude Code", pi: "Pi" }[tool];
      deps.stdout(
        `${label} ${write.targetSessionId}: ${write.appendedCount} records appended; OpenCode ${id}: ${returned} messages appended`,
      );
    };
    if (!all) {
      await sync(id!);
      return 0;
    }
    let processed = 0;
    let rejected = 0;
    for (const conversation of registry.conversations) {
      const mirror = conversation.mirrors.opencode;
      if (
        conversation.status !== "active" ||
        !mirror?.exportPrefix ||
        !conversation.mirrors[mirror.seedTool ?? "codex"] ||
        (mirror.openCodeDatabasePath &&
          mirror.openCodeDatabasePath !== databasePath)
      )
        continue;
      try {
        await sync(mirror.nativeId);
        processed += 1;
      } catch (error) {
        rejected += 1;
        deps.stdout(
          `OpenCode ${mirror.nativeId}: rejected (${(error as Error).message})`,
        );
      }
    }
    deps.stdout(`${processed} linked sessions processed, ${rejected} rejected`);
    return rejected ? 1 : 0;
  }

  if (command === "return-to-opencode") {
    const [id, database] = rest;
    if (!id || !database || rest.length !== 2 || restWithFlags.length !== 2) {
      throw new Error(
        "Usage: return-to-opencode <linked Codex session ID> <OpenCode database path>",
      );
    }
    const version = execFileSync("opencode", ["--version"], {
      encoding: "utf8",
      timeout: 5000,
    })
      .trim()
      .replace(/^opencode v/, "");
    const count = await returnCodexTurnsToOpenCode({
      registryPath: resolveRegistryPath(homeDir),
      codexSessionId: id,
      databasePath: resolve(cwd, database),
      version,
    });
    deps.stdout(`OpenCode: ${count} messages appended`);
    return 0;
  }

  if (command === "import-opencode") {
    const targetCwd = readOption(restWithFlags, "--target-cwd");
    const tool = readOption(restWithFlags, "--tool");
    const fromDatabase = hasFlag(restWithFlags, "--database");
    const database = readOption(restWithFlags, "--database");
    if (
      (fromDatabase
        ? !database || database.startsWith("--") || rest.length !== 0
        : rest.length === 0) ||
      (hasFlag(restWithFlags, "--target-cwd") &&
        (!targetCwd || targetCwd.startsWith("--"))) ||
      (hasFlag(restWithFlags, "--tool") &&
        tool !== "pi" &&
        tool !== "claude" &&
        tool !== "codex")
    ) {
      throw new Error(
        "Usage: import-opencode <OpenCode v2 export.json>... or --database <OpenCode database> [--dry-run] [--tool pi|claude|codex] [--target-cwd DIRECTORY]",
      );
    }
    let successful = 0;
    let rejected = 0;
    const destination = targetCwd ? resolve(cwd, targetCwd) : undefined;
    const databasePath = database
      ? await fs.realpath(resolve(cwd, database))
      : undefined;
    let version: string | undefined;
    let sources = rest;
    if (databasePath) {
      version = execFileSync("opencode", ["--version"], {
        encoding: "utf8",
        timeout: 5000,
      })
        .trim()
        .replace(/^opencode v/, "");
      const { listOpenCodeSessionIds } =
        await import("../../core/src/opencode-store.js");
      sources = listOpenCodeSessionIds(databasePath, version);
    }
    for (const [index, source] of sources.entries()) {
      const sourcePath = databasePath ?? resolve(cwd, source);
      const label = databasePath ? `OpenCode ${source}` : `export ${index + 1}`;
      try {
        const reportOmissions = (count: number | undefined) => {
          if (count)
            deps.stdout(
              `${label}: ${count} system record${count === 1 ? "" : "s"} omitted`,
            );
        };
        if (dryRun) {
          const snapshot = version
            ? await loadOpenCodeDatabaseSnapshot(sourcePath, version, source)
            : await loadSourceSessionSnapshot("opencode", sourcePath);
          if (version && !snapshot.chunks.length)
            throw new Error("OpenCode session has no supported messages");
          const linked = findConversationByNativeSession(
            registry,
            "opencode",
            snapshot.sourceSessionId,
          );
          if (
            !(
              await fs.stat(destination ?? linked?.canonicalCwd ?? snapshot.cwd)
            ).isDirectory()
          ) {
            throw new Error("Project path is not a directory");
          }
          reportOmissions(snapshot.omittedSystemRecords);
          deps.stdout(
            `${label}: ${snapshot.chunks.length} supported messages; no writes`,
          );
        } else {
          const result = await syncSourceSessionToTargets({
            sourceTool: "opencode",
            sourcePath,
            sourceSessionId: version ? source : undefined,
            openCodeDatabaseVersion: version,
            targetTools,
            targetCwd: destination,
            registryPath: resolveRegistryPath(homeDir),
            homeDir,
          });
          reportOmissions(result.snapshot.omittedSystemRecords);
          for (const write of result.writes) {
            deps.stdout(
              `${write.targetTool}: ${write.targetSessionId} (${write.appendedCount} records appended)`,
            );
          }
        }
        successful++;
      } catch (error) {
        rejected++;
        const reason =
          error instanceof SyntaxError
            ? "Malformed JSON"
            : error instanceof Error
              ? error.message
              : "Unknown import error";
        deps.stdout(`${label} rejected: ${reason}`);
      }
    }
    deps.stdout(
      `${successful} ${dryRun ? "validated" : "processed"}, ${rejected} rejected`,
    );
    return rejected ? 1 : 0;
  }

  if (command === "import") {
    if (importMode === "--latest") {
      let importedCount = 0;
      for (const targetTool of targetTools) {
        const result = await importLatestSessionToTarget({
          targetTool,
          dryRun,
          cwd,
          homeDir,
          registryPath: resolveRegistryPath(homeDir),
        });
        if (dryRun ? result.candidate : result.imported) {
          importedCount += 1;
        }
        deps.stdout(
          `import ${targetTool}: ${
            (dryRun ? result.candidate : result.imported)
              ? (result.candidate?.id ?? "imported")
              : "no candidate"
          }${dryRun ? " (dry-run)" : ""}`,
        );
      }
      return importedCount > 0 ? 0 : 1;
    }

    const candidates = (
      await listForeignSessionCandidates(cwd, homeDir)
    ).filter(
      (candidate) =>
        findConversationByNativeSession(
          registry,
          candidate.sourceTool,
          candidate.id,
        )?.mirrors[candidate.sourceTool]?.seededSourceOffset == null,
    );
    if (dryRun) {
      const routes = candidates.reduce(
        (count, candidate) =>
          count +
          targetTools.filter((target) => target !== candidate.sourceTool)
            .length,
        0,
      );
      deps.stdout(`dry-run: ${routes} candidate routes; no writes`);
      return 0;
    }
    let importedCount = 0;

    for (const candidate of candidates) {
      for (const targetTool of targetTools) {
        if (targetTool === candidate.sourceTool) {
          continue;
        }
        const result = await syncSourceSessionToTargets({
          sourceTool: candidate.sourceTool,
          sourcePath: candidate.path,
          sourceSessionId: candidate.id,
          registryPath: resolveRegistryPath(homeDir),
          homeDir,
          targetTools: [targetTool],
        });
        importedCount += result.writes.reduce(
          (count, write) => count + write.appendedCount,
          0,
        );
      }
    }

    deps.stdout(`imported ${importedCount} entries in ${importMode}`);
    return 0;
  }

  if (command === "link") {
    const [bridgeSessionId, projectKey] = rest;
    if (!bridgeSessionId || !projectKey) {
      deps.stdout("usage: link <bridgeSessionId> <projectKey>");
      return 1;
    }

    if (!dryRun) {
      const now = new Date().toISOString();
      const next = upsertConversation(registry, {
        bridgeSessionId,
        projectKey,
        canonicalCwd: projectKey,
        createdAt: now,
        updatedAt: now,
        status: "active",
        mirrors: {},
        lastWrittenOffsets: [],
      });
      await deps.save(next);
    }
    deps.stdout(
      `linked ${bridgeSessionId} -> ${projectKey}${dryRun ? " (dry-run)" : ""}`,
    );
    return 0;
  }

  if (command === "audit") {
    deps.stdout(JSON.stringify(registry, null, 2));
    return 0;
  }

  if (command === "import-project") {
    const [projectKey] = rest;
    const conversation = projectKey
      ? findConversationByProjectKey(registry, projectKey)
      : undefined;
    deps.stdout(
      conversation ? conversation.bridgeSessionId : "no conversation",
    );
    return 0;
  }

  deps.stdout(`unknown command: ${command}`);
  return 1;
}

export async function main(): Promise<number> {
  const homeDir = homedir();
  const registryPath = resolveRegistryPath(homeDir);

  return runCli(process.argv.slice(2), {
    homeDir,
    cwd: process.cwd(),
    load: () =>
      loadRegistry(registryPath, {
        readFile: fs.readFile,
      }),
    save: (registry) =>
      saveRegistry(registryPath, registry, {
        mkdir: async (path, options) => {
          await fs.mkdir(path, options);
        },
        writeFile: fs.writeFile,
        rename: fs.rename,
      }),
    readFile: fs.readFile,
    writeFile: fs.writeFile,
    mkdir: fs.mkdir,
    lstat: fs.lstat,
    unlink: fs.unlink,
    symlink: fs.symlink,
    rm: fs.rm,
    stdout: (line) => {
      console.log(line);
    },
  });
}

export function isCliEntrypoint(
  argv1: string | undefined,
  moduleUrl: string = import.meta.url,
): boolean {
  if (argv1 == null) {
    return false;
  }

  const modulePath = fileURLToPath(moduleUrl);
  if (modulePath === argv1) {
    return true;
  }

  try {
    return realpathSync(modulePath) === realpathSync(argv1);
  } catch {
    return false;
  }
}

const isMain = isCliEntrypoint(process.argv[1], import.meta.url);

if (isMain) {
  main().then((code) => {
    process.exitCode = code;
  });
}
