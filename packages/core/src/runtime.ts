import {
  access,
  appendFile,
  mkdir,
  lstat,
  open,
  realpath,
  readFile,
  readdir,
  rename,
  rmdir,
  stat,
  writeFile,
} from "node:fs/promises";
import { execFile as execFileCallback } from "node:child_process";
import { randomUUID, createHash, randomBytes } from "node:crypto";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";

import {
  convertClaudeLineToNormalized,
  convertCodexItemToNormalized,
  convertNormalizedToClaudeLine,
  convertNormalizedToPiEntry,
  convertPiEntryToNormalized,
} from "./converters.js";
import { selectImportCandidate, type SessionCandidate } from "./discovery.js";
import { decideSyncChunk, applySyncDecision } from "./dedupe.js";
import {
  deriveProjectKey,
  dirname,
  findGitRepoRoot,
  getClaudeCodeProjectDir,
  getCodexSessionDir,
  getPiSessionDir,
  normalizePath,
} from "./path-utils.js";
import {
  readClaudeCodeSession,
  readCodexRollout,
  iterateCodexRollout,
  readPiSession,
} from "./parsers.js";
import {
  emptyRegistry,
  findConversationsByProjectKey,
  findConversationByNativeSession,
  loadRegistry,
  saveRegistry,
  upsertConversation,
} from "./registry.js";
import { convertConversationToCodexRollout } from "./sync.js";
import type {
  BridgeConversation,
  BridgeRegistry,
  ClaudeCodeLine,
  CodexRolloutItem,
  NormalizedMessage,
  PiSessionEntry,
  PiSessionHeader,
  ToolMirror,
  ToolName,
} from "./types.js";

export interface SourceMessageChunk {
  sourceOffset: number;
  message: NormalizedMessage;
}

export interface SourceSessionSnapshot {
  sourceTool: ToolName;
  sourcePath: string;
  sourceSessionId: string;
  cwd: string;
  updatedAt: string;
  chunks: SourceMessageChunk[];
  rawMessageCount?: number;
  omittedSystemRecords?: number;
}

export interface SyncWriteResult {
  targetTool: ToolName;
  sessionPath: string;
  targetSessionId: string;
  appendedCount: number;
}

export interface SyncSourceSessionResult {
  conversation: BridgeConversation;
  registry: BridgeRegistry;
  writes: SyncWriteResult[];
  snapshot: SourceSessionSnapshot;
}

export interface CodexThreadIndexBackfillResult {
  threadId: string;
  indexed: boolean;
  reason?:
    | "missing-db"
    | "missing-schema"
    | "invalid-thread-id"
    | "missing-rollout"
    | "missing-session-meta";
}

const execFile = promisify(execFileCallback);

async function waitForSourceSessionFile(
  sourcePath: string,
  attempts = 6,
  delayMs = 50,
) {
  let lastError: NodeJS.ErrnoException | null = null;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await stat(sourcePath);
    } catch (error) {
      const nodeError = error as NodeJS.ErrnoException;
      if (nodeError.code !== "ENOENT") {
        throw error;
      }
      lastError = nodeError;
      if (attempt < attempts - 1) {
        await delay(delayMs);
      }
    }
  }

  throw lastError ?? new Error(`Could not stat source session ${sourcePath}`);
}

function formatSessionStamp(date: Date): string {
  return date.toISOString().replaceAll(":", "-").replaceAll(".", "-");
}

function formatCodexRolloutStamp(date: Date): string {
  const year = String(date.getFullYear());
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  const seconds = String(date.getSeconds()).padStart(2, "0");
  return `${year}-${month}-${day}T${hours}-${minutes}-${seconds}`;
}

function deterministicHex(seed: string): string {
  return createHash("sha1").update(seed).digest("hex");
}

function deterministicUuid(seed: string): string {
  const hex = deterministicHex(seed).slice(0, 32);
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join("-");
}

function deterministicPiId(seed: string): string {
  return deterministicHex(seed).slice(0, 8);
}

function formatUuidBytes(bytes: Uint8Array): string {
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0"));
  return [
    hex.slice(0, 4).join(""),
    hex.slice(4, 6).join(""),
    hex.slice(6, 8).join(""),
    hex.slice(8, 10).join(""),
    hex.slice(10, 16).join(""),
  ].join("-");
}

export function generateCodexThreadId(date = new Date()): string {
  const bytes = randomBytes(16);
  const timestamp = BigInt(date.getTime());

  bytes[0] = Number((timestamp >> 40n) & 0xffn);
  bytes[1] = Number((timestamp >> 32n) & 0xffn);
  bytes[2] = Number((timestamp >> 24n) & 0xffn);
  bytes[3] = Number((timestamp >> 16n) & 0xffn);
  bytes[4] = Number((timestamp >> 8n) & 0xffn);
  bytes[5] = Number(timestamp & 0xffn);

  bytes[6] = (bytes[6]! & 0x0f) | 0x70;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;

  return formatUuidBytes(bytes);
}

export function isCodexThreadId(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    value,
  );
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function walkJsonlFiles(root: string): Promise<string[]> {
  if (!(await exists(root))) {
    return [];
  }

  const queue = [root];
  const files: string[] = [];

  while (queue.length > 0) {
    const current = queue.shift()!;
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = join(current, entry.name);
      if (entry.isDirectory()) {
        queue.push(fullPath);
      } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        files.push(fullPath);
      }
    }
  }

  return files.sort();
}

async function appendJsonLines(
  path: string,
  items: unknown[],
  checkBoundary: boolean,
): Promise<void> {
  if (!items.length) return;
  await mkdir(dirname(path), { recursive: true });
  const records = items.map((item) => JSON.stringify(item)).join("\n") + "\n";
  if (!checkBoundary) {
    await appendFile(path, records, "utf8");
    return;
  }
  const file = await open(path, "a+");
  try {
    const { size } = await file.stat();
    const last = Buffer.alloc(1);
    if (size) {
      const { bytesRead } = await file.read(last, 0, 1, size - 1);
      if (bytesRead !== 1)
        throw new Error(
          "Target transcript changed while checking its last record",
        );
    }
    await file.appendFile(
      size && last[0] !== 10 ? "\n" + records : records,
      "utf8",
    );
  } finally {
    await file.close();
  }
}

function extractCodexThreadTitleAndFirstUserMessage(
  chunks: SourceMessageChunk[],
): { title: string; firstUserMessage: string } {
  for (const chunk of chunks) {
    if (chunk.message.role !== "user") {
      continue;
    }

    const text = chunk.message.content
      .flatMap((item) => (item.type === "text" ? [item.text] : []))
      .map((part) => part.trim())
      .filter(Boolean)
      .join("\n\n")
      .trim();

    if (text.length > 0) {
      return {
        title: text,
        firstUserMessage: text,
      };
    }
  }

  return {
    title: "Imported session",
    firstUserMessage: "",
  };
}

function escapeSqlLiteral(value: string): string {
  return value.replaceAll("'", "''");
}

async function findCodexStateDbPath(homeDir: string): Promise<string | null> {
  const codexDir = join(homeDir, ".codex");
  const entries = await readdir(codexDir).catch(() => []);
  const candidates = entries
    .filter((entry) => /^state_\d+\.sqlite$/u.test(entry))
    .sort((left, right) => {
      const leftNumber = Number.parseInt(left.replace(/\D+/gu, ""), 10);
      const rightNumber = Number.parseInt(right.replace(/\D+/gu, ""), 10);
      return rightNumber - leftNumber;
    });

  return candidates.length > 0 ? join(codexDir, candidates[0]!) : null;
}

async function getSqliteTableColumns(
  dbPath: string,
  tableName: string,
): Promise<Set<string>> {
  try {
    const { stdout } = await execFile("sqlite3", [
      dbPath,
      `PRAGMA table_info(${tableName});`,
    ]);

    const columns = stdout
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => line.split("|")[1]?.trim())
      .filter((value): value is string => Boolean(value));

    return new Set(columns);
  } catch {
    return new Set();
  }
}

function buildSqlAssignment(
  column: string,
  value: string | number,
): { column: string; valueSql: string } {
  return {
    column,
    valueSql:
      typeof value === "number"
        ? String(value)
        : `'${escapeSqlLiteral(value)}'`,
  };
}

type CodexRolloutMeta = {
  cliVersion?: string;
  source?: string;
  modelProvider?: string;
  model?: string;
  approvalPolicy?: string;
  reasoningEffort?: string;
};

// Best-effort read of the rollout's own metadata so backfilled rows reflect
// the session that produced it instead of hardcoded defaults.
async function readCodexRolloutMeta(
  rolloutPath: string,
): Promise<CodexRolloutMeta> {
  const meta: CodexRolloutMeta = {};
  try {
    const text = await readFile(rolloutPath, "utf8");
    for (const line of text.split("\n").slice(0, 200)) {
      if (!line.trim()) continue;
      let entry: { type?: string; payload?: Record<string, unknown> };
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }
      const payload = entry.payload ?? {};
      const str = (v: unknown) =>
        typeof v === "string" && v.length > 0 ? v : undefined;
      if (entry.type === "session_meta") {
        meta.cliVersion ??= str(payload.cli_version);
        meta.source ??= str(payload.source);
        meta.modelProvider ??= str(payload.model_provider);
      } else if (entry.type === "turn_context") {
        meta.model ??= str(payload.model);
        meta.approvalPolicy ??= str(payload.approval_policy);
        meta.reasoningEffort ??= str(payload.effort);
      }
      if (meta.cliVersion && meta.model && meta.approvalPolicy) break;
    }
  } catch {
    // Rollout unreadable: fall back to defaults.
  }
  return meta;
}

async function upsertCodexThreadIndex(params: {
  homeDir: string;
  threadId: string;
  rolloutPath: string;
  cwd: string;
  createdAt: string;
  updatedAt: string;
  title: string;
  firstUserMessage: string;
}) {
  const dbPath = await findCodexStateDbPath(params.homeDir);
  if (!dbPath) {
    return;
  }

  const availableColumns = await getSqliteTableColumns(dbPath, "threads");
  if (!availableColumns.has("id")) {
    return;
  }

  const rollout = await readCodexRolloutMeta(params.rolloutPath);
  const createdAtSeconds = Math.floor(Date.parse(params.createdAt) / 1000);
  const updatedAtSeconds = Math.floor(Date.parse(params.updatedAt) / 1000);
  const requestedAssignments = [
    buildSqlAssignment("id", params.threadId),
    buildSqlAssignment("rollout_path", params.rolloutPath),
    buildSqlAssignment("created_at", createdAtSeconds),
    buildSqlAssignment("updated_at", updatedAtSeconds),
    buildSqlAssignment("source", rollout.source ?? "vscode"),
    buildSqlAssignment("model_provider", rollout.modelProvider ?? "openai"),
    buildSqlAssignment("cwd", params.cwd),
    buildSqlAssignment("title", params.title),
    buildSqlAssignment("sandbox_policy", "workspace-write"),
    buildSqlAssignment("approval_mode", rollout.approvalPolicy ?? "never"),
    buildSqlAssignment("tokens_used", 0),
    buildSqlAssignment(
      "has_user_event",
      params.firstUserMessage.length > 0 ? 1 : 0,
    ),
    buildSqlAssignment("archived", 0),
    buildSqlAssignment("cli_version", rollout.cliVersion ?? "0.115.0"),
    buildSqlAssignment("first_user_message", params.firstUserMessage),
    buildSqlAssignment("memory_mode", "enabled"),
    buildSqlAssignment("model", rollout.model ?? "gpt-5.4"),
    buildSqlAssignment("reasoning_effort", rollout.reasoningEffort ?? "medium"),
    // Codex's resume picker skips rows with an empty preview.
    buildSqlAssignment("preview", params.firstUserMessage),
    buildSqlAssignment("thread_source", "user"),
    buildSqlAssignment("created_at_ms", createdAtSeconds * 1000),
    buildSqlAssignment("updated_at_ms", updatedAtSeconds * 1000),
    buildSqlAssignment("recency_at", updatedAtSeconds),
    buildSqlAssignment("recency_at_ms", updatedAtSeconds * 1000),
  ].filter((assignment) => availableColumns.has(assignment.column));

  const insertColumns = requestedAssignments.map(
    (assignment) => assignment.column,
  );
  const insertValues = requestedAssignments.map(
    (assignment) => assignment.valueSql,
  );
  const updateAssignments = requestedAssignments
    .filter((assignment) => assignment.column !== "id")
    .map(
      (assignment) => `${assignment.column} = excluded.${assignment.column}`,
    );

  if (
    insertColumns.length === 0 ||
    !insertColumns.includes("rollout_path") ||
    !insertColumns.includes("cwd")
  ) {
    return;
  }

  const sql = `
INSERT INTO threads (${insertColumns.join(", ")})
VALUES (${insertValues.join(", ")})
ON CONFLICT(id) DO UPDATE SET
  ${updateAssignments.join(",\n  ")};
`;

  try {
    // Feed the statement on stdin: long first messages are written into the
    // SQL several times and would exceed the per-argument limit (~128KB).
    const run = execFile("sqlite3", [dbPath]);
    // A live Codex can hold the state DB lock; wait for it instead of failing.
    run.child.stdin?.end(`.timeout 5000\n${sql}`);
    await run;
  } catch {
    // Resume-by-id still works from the rollout scan fallback even when the
    // local thread index is unavailable.
  }
}

export async function hasCodexThreadIndexEntry(
  homeDir: string,
  threadId: string,
): Promise<boolean> {
  const dbPath = await findCodexStateDbPath(homeDir);
  if (!dbPath) {
    return false;
  }

  try {
    const { stdout } = await execFile("sqlite3", [
      dbPath,
      `SELECT 1 FROM threads WHERE id = '${escapeSqlLiteral(threadId)}' LIMIT 1;`,
    ]);
    return stdout.trim() === "1";
  } catch {
    return false;
  }
}

export async function backfillCodexThreadIndex(params: {
  homeDir: string;
  threadId: string;
  rolloutPath: string;
  cwd?: string;
}): Promise<CodexThreadIndexBackfillResult> {
  const dbPath = await findCodexStateDbPath(params.homeDir);
  if (!dbPath) {
    return {
      threadId: params.threadId,
      indexed: false,
      reason: "missing-db",
    };
  }

  const availableColumns = await getSqliteTableColumns(dbPath, "threads");
  if (!availableColumns.has("id")) {
    return {
      threadId: params.threadId,
      indexed: false,
      reason: "missing-schema",
    };
  }

  if (!isCodexThreadId(params.threadId)) {
    return {
      threadId: params.threadId,
      indexed: false,
      reason: "invalid-thread-id",
    };
  }

  if (!(await exists(params.rolloutPath))) {
    return {
      threadId: params.threadId,
      indexed: false,
      reason: "missing-rollout",
    };
  }

  const snapshot = await loadSourceSessionSnapshot(
    "codex",
    params.rolloutPath,
    params.threadId,
  );
  const sessionMeta = (await readCodexRollout(params.rolloutPath)).find(
    (item) => item.type === "session_meta",
  );

  if (!sessionMeta) {
    return {
      threadId: params.threadId,
      indexed: false,
      reason: "missing-session-meta",
    };
  }

  const { title, firstUserMessage } =
    extractCodexThreadTitleAndFirstUserMessage(snapshot.chunks);
  const createdAt = snapshot.chunks[0]?.message.timestamp ?? snapshot.updatedAt;

  await upsertCodexThreadIndex({
    homeDir: params.homeDir,
    threadId: params.threadId,
    rolloutPath: params.rolloutPath,
    cwd: params.cwd ?? snapshot.cwd,
    createdAt,
    updatedAt: snapshot.updatedAt,
    title,
    firstUserMessage,
  });

  return {
    threadId: params.threadId,
    indexed: await hasCodexThreadIndexEntry(params.homeDir, params.threadId),
  };
}

function getPiEntryTimestamp(entry: PiSessionEntry): string | undefined {
  return entry.timestamp;
}

function getClaudeLineTimestamp(line: ClaudeCodeLine): string | undefined {
  return line.timestamp;
}

function getCodexItemTimestamp(item: CodexRolloutItem): string | undefined {
  const payloadTimestamp =
    typeof item.payload.timestamp === "string" ? item.payload.timestamp : null;
  return (
    ((item as { timestamp?: unknown }).timestamp as string | undefined) ??
    payloadTimestamp ??
    undefined
  );
}

function createPiHeader(
  cwd: string,
  sessionId: string,
  timestamp: string,
): PiSessionHeader {
  return {
    type: "session",
    version: 3,
    id: sessionId,
    timestamp,
    cwd,
  };
}

async function loadTargetClaudeState(path: string): Promise<{
  count: number;
  lastUuid: string | null;
}> {
  if (!(await exists(path))) {
    return { count: 0, lastUuid: null };
  }

  const lines = await readClaudeCodeSession(path);
  let lastUuid: string | null = null;
  for (const line of lines) {
    if (typeof line.uuid === "string") {
      lastUuid = line.uuid;
    }
  }
  return { count: lines.length, lastUuid };
}

async function loadTargetPiState(path: string): Promise<{
  count: number;
  lastId: string | null;
}> {
  if (!(await exists(path))) {
    return { count: 0, lastId: null };
  }

  const session = await readPiSession(path);
  const last = session.entries[session.entries.length - 1];
  return {
    count: session.entries.length,
    lastId: typeof last?.id === "string" ? last.id : null,
  };
}

async function loadTargetCodexState(path: string): Promise<{
  count: number;
  hasMeta: boolean;
}> {
  if (!(await exists(path))) {
    return { count: 0, hasMeta: false };
  }

  let count = 0;
  let hasMeta = false;
  for await (const item of iterateCodexRollout(path)) {
    count += 1;
    hasMeta ||= item.type === "session_meta";
  }
  return { count, hasMeta };
}

// shortcut: carry tool history as inert transcript text until every target can replay native tool pairs safely.
function openCodeHistoryBlock(block: any): { type: "text"; text: string }[] {
  if (block?.type === "text" && typeof block.text === "string") return [block];
  if (block?.type === "reasoning") return [];
  const state = block?.state;
  if (
    block?.type !== "tool" ||
    typeof block.name !== "string" ||
    typeof block.id !== "string" ||
    !state ||
    typeof state.input !== "object" ||
    !state.input ||
    Array.isArray(state.input)
  ) {
    throw new Error("Unsupported OpenCode assistant content");
  }
  if (
    state.status === "completed" &&
    (!Array.isArray(state.content) ||
      state.content.some(
        (part: any) =>
          part?.type !== "file" &&
          (part?.type !== "text" || typeof part.text !== "string"),
      ))
  ) {
    throw new Error("Unsupported OpenCode tool result");
  }
  if (state.status !== "completed" && state.status !== "error") {
    throw new Error("OpenCode tool call is unsettled");
  }
  return [
    {
      type: "text",
      text:
        "Historical OpenCode tool record (already settled): " +
        JSON.stringify({
          id: block.id,
          name: block.name,
          input: state.input,
          status: state.status,
          ...(state.status === "completed"
            ? {
                output: state.content.map((part: any) =>
                  part.type === "file"
                    ? "[Source tool attachment omitted; see the original session]"
                    : part.text,
                ),
              }
            : { error: state.error }),
        }),
    },
  ];
}

function normalizeOpenCodeMessages(
  messages: any[],
  startOffset = 0,
): SourceMessageChunk[] {
  return messages.flatMap((entry, index) => {
    if (
      entry?.type === "agent-switched" ||
      entry?.type === "idle" ||
      entry?.type === "model-switched" ||
      entry?.type === "system"
    )
      return [];
    let historical: string | undefined;
    if (entry?.type === "synthetic" && typeof entry.text === "string") {
      historical =
        "Historical OpenCode synthetic record: " + JSON.stringify(entry.text);
    } else if (
      entry?.type === "compaction" &&
      entry.status === "completed" &&
      typeof entry.summary === "string"
    ) {
      historical =
        "Historical OpenCode compaction summary: " +
        JSON.stringify(entry.summary);
    } else if (entry?.type === "compaction" && entry.status === "failed") {
      historical = "[Source OpenCode compaction failed]";
    } else if (
      entry?.type === "shell" &&
      (entry.status === "exited" || entry.status === "killed") &&
      typeof entry.command === "string"
    ) {
      historical =
        "Historical OpenCode shell record: " +
        JSON.stringify({
          command: entry.command,
          status: entry.status,
          exit: entry.exit,
          output: entry.output,
        });
    } else if (entry?.type === "location-switched" && entry.location) {
      historical =
        "Historical OpenCode project location change: " +
        JSON.stringify(entry.location);
    }
    const blocks =
      historical !== undefined
        ? [{ type: "text", text: historical }]
        : entry?.type === "user" && typeof entry.text === "string"
          ? [
              {
                type: "text",
                text: entry.files?.length
                  ? entry.text +
                    "\n[Source attachments omitted; see the original session]"
                  : entry.text,
              },
            ]
          : entry?.type === "assistant"
            ? entry.error && Array.isArray(entry.content)
              ? [
                  ...entry.content,
                  {
                    type: "text",
                    text: "[Source OpenCode assistant turn failed]",
                  },
                ]
              : entry.content
            : null;
    if (
      (entry?.error &&
        entry.type !== "assistant" &&
        historical === undefined) ||
      typeof entry?.id !== "string" ||
      !Number.isFinite(entry?.time?.created) ||
      !Array.isArray(blocks)
    ) {
      throw new Error(`Unsupported OpenCode message at index ${index}`);
    }
    const content =
      entry.type === "assistant"
        ? blocks.flatMap(openCodeHistoryBlock)
        : blocks.map((block) => {
            if (typeof block.text !== "string")
              throw new Error("Invalid OpenCode user text");
            return block;
          });
    if (!content.length) return [];
    return [
      {
        sourceOffset: startOffset + index + 1,
        message: {
          id: entry.id,
          role: historical !== undefined ? "assistant" : entry.type,
          timestamp: new Date(entry.time.created).toISOString(),
          content,
        },
      },
    ];
  });
}

export async function loadSourceSessionSnapshot(
  sourceTool: ToolName,
  sourcePath: string,
  explicitSessionId?: string,
): Promise<SourceSessionSnapshot> {
  const info = await waitForSourceSessionFile(sourcePath);

  if (sourceTool === "opencode") {
    const bundle = JSON.parse(await readFile(sourcePath, "utf8"));
    const { info, messages } = bundle;
    const cwd = info?.location?.directory;
    const id = info?.id;
    if (
      typeof cwd !== "string" ||
      !cwd.startsWith("/") ||
      typeof id !== "string" ||
      !id.startsWith("ses_") ||
      !Array.isArray(messages)
    ) {
      throw new Error("Expected an OpenCode v2 session export");
    }
    if (explicitSessionId && id !== explicitSessionId)
      throw new Error("OpenCode export session identity changed");
    const chunks = normalizeOpenCodeMessages(messages);
    return {
      sourceTool,
      sourcePath,
      sourceSessionId: id,
      rawMessageCount: messages.length,
      omittedSystemRecords: messages.filter(
        (message) => message?.type === "system",
      ).length,
      cwd,
      updatedAt: new Date(
        info.time?.updated ?? info.time?.created,
      ).toISOString(),
      chunks,
    };
  }

  if (sourceTool === "pi") {
    const session = await readPiSession(sourcePath);
    return {
      sourceTool,
      sourcePath,
      sourceSessionId: explicitSessionId ?? session.header.id,
      cwd: session.header.cwd,
      updatedAt:
        session.entries.at(-1)?.timestamp ??
        session.header.timestamp ??
        info.mtime.toISOString(),
      chunks: session.entries.flatMap((entry, index) => {
        const normalized = convertPiEntryToNormalized(entry);
        return normalized
          ? [{ sourceOffset: index + 1, message: normalized }]
          : [];
      }),
    };
  }

  if (sourceTool === "claude") {
    const lines = await readClaudeCodeSession(sourcePath);
    const sourceSessionId =
      explicitSessionId ??
      lines.find((line) => typeof line.sessionId === "string")?.sessionId ??
      deterministicUuid(sourcePath);
    const cwd = lines.find((line) => typeof line.cwd === "string")?.cwd ?? "/";
    const timestamps = lines
      .map((line) => getClaudeLineTimestamp(line))
      .filter((value): value is string => Boolean(value));

    const seenToolBlocks = new Set<string>();
    return {
      sourceTool,
      sourcePath,
      sourceSessionId,
      cwd,
      updatedAt: timestamps.at(-1) ?? info.mtime.toISOString(),
      chunks: lines.flatMap((line, index) => {
        const normalized = convertClaudeLineToNormalized(line);
        if (!normalized) return [];
        const content = normalized.content.filter((block) => {
          if (block.type !== "tool_call" && block.type !== "tool_result")
            return true;
          const key = JSON.stringify(block);
          if (seenToolBlocks.has(key)) return false;
          seenToolBlocks.add(key);
          return true;
        });
        if (!content.length && normalized.content.length) return [];
        return [
          { sourceOffset: index + 1, message: { ...normalized, content } },
        ];
      }),
    };
  }

  let sessionMeta: Record<string, unknown> | undefined;
  let updatedAt = info.mtime.toISOString();
  let sourceOffset = 0;
  const chunks: SourceMessageChunk[] = [];
  for await (const item of iterateCodexRollout(sourcePath)) {
    sourceOffset += 1;
    if (item.type === "session_meta") sessionMeta ??= item.payload;
    const timestamp = getCodexItemTimestamp(item);
    if (timestamp) updatedAt = timestamp;
    const message = convertCodexItemToNormalized(item);
    if (message) chunks.push({ sourceOffset, message });
  }

  return {
    sourceTool,
    sourcePath,
    sourceSessionId:
      explicitSessionId ??
      (typeof sessionMeta?.id === "string"
        ? sessionMeta.id
        : deterministicUuid(sourcePath)),
    cwd: typeof sessionMeta?.cwd === "string" ? sessionMeta.cwd : "/",
    updatedAt,
    chunks,
  };
}

function createConversation(
  projectKey: string,
  canonicalCwd: string,
  sourceTool: ToolName,
  sourceSessionId: string,
  sourcePath: string,
  now: string,
): BridgeConversation {
  return {
    bridgeSessionId: randomUUID(),
    projectKey,
    canonicalCwd,
    createdAt: now,
    updatedAt: now,
    status: "active",
    lastOriginTool: sourceTool,
    mirrors: {
      [sourceTool]: {
        nativeId: sourceSessionId,
        sessionPath: sourcePath,
      },
    },
    lastWrittenOffsets: [],
  };
}

function attachSourceMirror(
  conversation: BridgeConversation,
  sourceTool: ToolName,
  sourceSessionId: string,
  sourcePath: string,
  updatedAt: string,
): BridgeConversation {
  return {
    ...conversation,
    updatedAt,
    lastOriginTool: sourceTool,
    mirrors: {
      ...conversation.mirrors,
      [sourceTool]: {
        ...conversation.mirrors[sourceTool],
        nativeId: sourceSessionId,
        sessionPath: sourcePath,
      },
    },
  };
}

function makeMirrorMessage(
  message: NormalizedMessage,
  sourceTool: ToolName,
  sourceSessionId: string,
  sourceOffset: number,
  targetTool: ToolName,
): NormalizedMessage {
  const seed = `${sourceTool}:${sourceSessionId}:${sourceOffset}:${targetTool}`;
  return {
    ...message,
    id: targetTool === "pi" ? deterministicPiId(seed) : deterministicUuid(seed),
  };
}

function getMaxSyncedSourceOffset(
  watermarks: BridgeConversation["lastWrittenOffsets"],
  sourceTool: ToolName,
  sourceSessionId: string,
  targetTool: ToolName,
  targetSessionId: string,
): number {
  return watermarks.reduce((maxOffset, watermark) => {
    if (
      watermark.sourceTool === sourceTool &&
      watermark.sourceSessionId === sourceSessionId &&
      watermark.targetTool === targetTool &&
      watermark.targetSessionId === targetSessionId
    ) {
      return Math.max(maxOffset, watermark.sourceOffset);
    }

    return maxOffset;
  }, 0);
}

function isImportedMirrorChunk(params: {
  watermarks: BridgeConversation["lastWrittenOffsets"];
  sourceTool: ToolName;
  sourceSessionId: string;
  sourceOffset: number;
}): boolean {
  return params.watermarks.some(
    (watermark) =>
      watermark.targetTool === params.sourceTool &&
      watermark.targetSessionId === params.sourceSessionId &&
      watermark.targetOffset === params.sourceOffset &&
      watermark.sourceTool !== params.sourceTool,
  );
}

async function ensureTargetMirror(
  conversation: BridgeConversation,
  targetTool: ToolName,
  homeDir: string,
  now: Date,
): Promise<ToolMirror> {
  const existing = conversation.mirrors[targetTool];
  if (
    existing &&
    (targetTool !== "codex" || isCodexThreadId(existing.nativeId))
  ) {
    return existing;
  }

  if (targetTool === "pi") {
    const sessionId = randomUUID();
    const path = join(
      getPiSessionDir(conversation.projectKey, homeDir),
      `${formatSessionStamp(now)}_${sessionId}.jsonl`,
    );
    return { nativeId: sessionId, sessionPath: path };
  }

  if (targetTool === "claude") {
    const sessionId = randomUUID();
    const path = join(
      getClaudeCodeProjectDir(conversation.projectKey, homeDir),
      `${sessionId}.jsonl`,
    );
    return { nativeId: sessionId, sessionPath: path };
  }

  const sessionId = generateCodexThreadId(now);
  const path = join(
    getCodexSessionDir(now, homeDir),
    `rollout-${formatCodexRolloutStamp(now)}-${sessionId}.jsonl`,
  );
  return { nativeId: sessionId, sessionPath: path };
}

async function appendToPiMirror(
  mirror: ToolMirror,
  cwd: string,
  sourceTool: ToolName,
  sourceSessionId: string,
  chunks: SourceMessageChunk[],
  watermarks: BridgeConversation["lastWrittenOffsets"],
): Promise<{
  appendedCount: number;
  nextWatermarks: BridgeConversation["lastWrittenOffsets"];
  finalCount: number;
}> {
  let { count, lastId } = await loadTargetPiState(mirror.sessionPath);
  let nextWatermarks = watermarks;
  let appendedCount = 0;
  let previousMirrorId: string | null = lastId;

  if (!(await exists(mirror.sessionPath))) {
    await mkdir(dirname(mirror.sessionPath), { recursive: true });
    await writeFile(
      mirror.sessionPath,
      `${JSON.stringify(
        createPiHeader(cwd, mirror.nativeId, new Date().toISOString()),
      )}\n`,
      "utf8",
    );
  }

  for (const chunk of chunks) {
    const mirrorMessage = makeMirrorMessage(
      chunk.message,
      sourceTool,
      sourceSessionId,
      chunk.sourceOffset,
      "pi",
    );
    const entry = convertNormalizedToPiEntry(mirrorMessage, previousMirrorId);
    const content = JSON.stringify(entry);
    const decision = decideSyncChunk(nextWatermarks, {
      sourceTool,
      sourceSessionId,
      sourceOffset: chunk.sourceOffset,
      targetTool: "pi",
      targetSessionId: mirror.nativeId,
      targetOffset: count + 1,
      content,
    });

    if (!decision.apply) {
      previousMirrorId = mirrorMessage.id;
      continue;
    }

    await appendJsonLines(mirror.sessionPath, [entry], appendedCount === 0);
    appendedCount += 1;
    count += 1;
    nextWatermarks = applySyncDecision(nextWatermarks, decision);
    previousMirrorId = mirrorMessage.id;
  }

  return { appendedCount, nextWatermarks, finalCount: count };
}

async function appendToClaudeMirror(
  mirror: ToolMirror,
  cwd: string,
  sourceTool: ToolName,
  sourceSessionId: string,
  chunks: SourceMessageChunk[],
  watermarks: BridgeConversation["lastWrittenOffsets"],
): Promise<{
  appendedCount: number;
  nextWatermarks: BridgeConversation["lastWrittenOffsets"];
  finalCount: number;
}> {
  let { count, lastUuid } = await loadTargetClaudeState(mirror.sessionPath);
  let nextWatermarks = watermarks;
  let appendedCount = 0;
  let previousMirrorId: string | null = lastUuid;

  await mkdir(dirname(mirror.sessionPath), { recursive: true });

  for (const chunk of chunks) {
    const mirrorMessage = makeMirrorMessage(
      chunk.message,
      sourceTool,
      sourceSessionId,
      chunk.sourceOffset,
      "claude",
    );
    const line = convertNormalizedToClaudeLine(
      mirrorMessage,
      mirror.nativeId,
      previousMirrorId,
      cwd,
    );
    const content = JSON.stringify(line);
    const decision = decideSyncChunk(nextWatermarks, {
      sourceTool,
      sourceSessionId,
      sourceOffset: chunk.sourceOffset,
      targetTool: "claude",
      targetSessionId: mirror.nativeId,
      targetOffset: count + 1,
      content,
    });

    if (!decision.apply) {
      previousMirrorId = mirrorMessage.id;
      continue;
    }

    await appendJsonLines(mirror.sessionPath, [line], appendedCount === 0);
    appendedCount += 1;
    count += 1;
    nextWatermarks = applySyncDecision(nextWatermarks, decision);
    previousMirrorId = mirrorMessage.id;
  }

  return { appendedCount, nextWatermarks, finalCount: count };
}

async function appendToCodexMirror(
  mirror: ToolMirror,
  cwd: string,
  homeDir: string,
  sourceTool: ToolName,
  sourceSessionId: string,
  chunks: SourceMessageChunk[],
  watermarks: BridgeConversation["lastWrittenOffsets"],
): Promise<{
  appendedCount: number;
  nextWatermarks: BridgeConversation["lastWrittenOffsets"];
  finalCount: number;
}> {
  if (mirror.sessionPath.endsWith(".zst")) {
    if (chunks.length)
      throw new Error(
        "Compressed Codex rollouts must be reopened in Codex before appending",
      );
    return {
      appendedCount: 0,
      nextWatermarks: watermarks,
      finalCount: (await loadTargetCodexState(mirror.sessionPath)).count,
    };
  }
  let { count, hasMeta } = await loadTargetCodexState(mirror.sessionPath);
  let nextWatermarks = watermarks;
  let appendedCount = 0;

  await mkdir(dirname(mirror.sessionPath), { recursive: true });

  if (!hasMeta && chunks.length > 0) {
    const [sessionMeta] = convertConversationToCodexRollout(
      [chunks[0]!.message],
      cwd,
      mirror.nativeId,
      {
        includeSessionMeta: true,
      },
    );

    if (sessionMeta) {
      await appendJsonLines(
        mirror.sessionPath,
        [
          {
            timestamp: chunks[0]!.message.timestamp,
            ...sessionMeta,
          },
        ],
        true,
      );
      count += 1;
      appendedCount += 1;
      hasMeta = true;
    }
  }

  for (const chunk of chunks) {
    const mirrorMessage = makeMirrorMessage(
      chunk.message,
      sourceTool,
      sourceSessionId,
      chunk.sourceOffset,
      "codex",
    );
    const lines = convertConversationToCodexRollout(
      [mirrorMessage],
      cwd,
      mirror.nativeId,
      {
        includeSessionMeta: false,
      },
    ).map((item) => ({
      timestamp: chunk.message.timestamp,
      ...item,
    }));

    const content = lines.map((line) => JSON.stringify(line)).join("\n");
    const decision = decideSyncChunk(nextWatermarks, {
      sourceTool,
      sourceSessionId,
      sourceOffset: chunk.sourceOffset,
      targetTool: "codex",
      targetSessionId: mirror.nativeId,
      targetOffset: count + lines.length,
      content,
    });

    if (!decision.apply) {
      continue;
    }

    await appendJsonLines(mirror.sessionPath, lines, appendedCount === 0);
    appendedCount += lines.length;
    count += lines.length;
    hasMeta = true;
    nextWatermarks = applySyncDecision(nextWatermarks, decision);
  }

  if (hasMeta) {
    const { title, firstUserMessage } =
      extractCodexThreadTitleAndFirstUserMessage(chunks);
    const createdAt = chunks[0]?.message.timestamp ?? new Date().toISOString();
    const updatedAt =
      chunks.at(-1)?.message.timestamp ??
      chunks[0]?.message.timestamp ??
      new Date().toISOString();
    await upsertCodexThreadIndex({
      homeDir,
      threadId: mirror.nativeId,
      rolloutPath: mirror.sessionPath,
      cwd,
      createdAt,
      updatedAt,
      title,
      firstUserMessage,
    });
  }

  return { appendedCount, nextWatermarks, finalCount: count };
}

const returnedOpenCodePrefix = "msg_b21d9e00";

function returnedOpenCodeId(
  codexId: string,
  offset: number,
  openCodeId: string,
) {
  return (
    returnedOpenCodePrefix +
    deterministicUuid(`${codexId}:${offset}:${openCodeId}`)
      .replaceAll("-", "")
      .slice(8)
  );
}

function linkedImportOffset(
  conversation: BridgeConversation,
  tool: Exclude<ToolName, "opencode">,
): number {
  const prefix = conversation.mirrors.opencode?.exportPrefix;
  return conversation.lastWrittenOffsets.reduce(
    (offset, watermark) =>
      watermark.sourceTool === "opencode" &&
      watermark.targetTool === tool &&
      watermark.targetSessionId === conversation.mirrors[tool]?.nativeId
        ? Math.max(offset, watermark.targetOffset)
        : offset,
    prefix?.linkedOffset ??
      (tool === "codex" ? prefix?.codexOffset : undefined) ??
      conversation.mirrors[tool]?.seededSourceOffset ??
      0,
  );
}

async function withRegistryWriteLock<T>(
  registryPath: string,
  run: () => Promise<T>,
): Promise<T> {
  const lockPath = `${registryPath}.write-lock`;
  await mkdir(dirname(registryPath), { recursive: true });
  try {
    await mkdir(lockPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new Error(
        "Bridge registry write is locked; retry when the other operation finishes",
      );
    }
    throw error;
  }
  try {
    return await run();
  } finally {
    await rmdir(lockPath);
  }
}

export function returnLinkedTurnsToOpenCode(
  params: Parameters<typeof returnLinkedTurnsUnderLock>[0],
): Promise<number> {
  return withRegistryWriteLock(params.registryPath, () =>
    returnLinkedTurnsUnderLock(params),
  );
}

export function returnCodexTurnsToOpenCode(
  params: Omit<
    Parameters<typeof returnLinkedTurnsUnderLock>[0],
    "tool" | "sessionId"
  > & {
    codexSessionId: string;
  },
): Promise<number> {
  return returnLinkedTurnsToOpenCode({
    ...params,
    tool: "codex",
    sessionId: params.codexSessionId,
  });
}

export function syncSourceSessionToTargets(
  params: Parameters<typeof syncSourceSessionUnderLock>[0],
): Promise<SyncSourceSessionResult> {
  return withRegistryWriteLock(params.registryPath, () =>
    syncSourceSessionUnderLock(params),
  );
}

export function syncOpenCodeSession(params: {
  registryPath: string;
  homeDir: string;
  databasePath: string;
  version: string;
  sessionId: string;
  outboundOnly?: boolean;
}) {
  return withRegistryWriteLock(params.registryPath, async () => {
    const registry = await loadRegistry(params.registryPath, { readFile });
    const linked = findConversationByNativeSession(
      registry,
      "opencode",
      params.sessionId,
    );
    const mirror = linked?.mirrors.opencode;
    if (
      mirror?.openCodeDatabasePath &&
      mirror.openCodeDatabasePath !== params.databasePath
    )
      throw new Error("OpenCode session is linked to a different database");
    const tool = mirror?.seedTool ?? "codex";
    const sendBack = (sessionId: string) =>
      returnLinkedTurnsUnderLock({
        registryPath: params.registryPath,
        tool,
        sessionId,
        databasePath: params.databasePath,
        version: params.version,
      });
    if (params.outboundOnly) {
      const source = linked?.mirrors[tool];
      if (!source || !mirror?.openCodeDatabasePath)
        throw new Error(
          "Outbound sync requires a session linked to this OpenCode database",
        );
      return {
        tool,
        write: { targetSessionId: source.nativeId, appendedCount: 0 },
        returned: await sendBack(source.nativeId),
      };
    }
    const result = await syncSourceSessionUnderLock({
      sourceTool: "opencode",
      sourcePath: params.databasePath,
      sourceSessionId: params.sessionId,
      openCodeDatabaseVersion: params.version,
      targetTools: [tool],
      registryPath: params.registryPath,
      homeDir: params.homeDir,
    });
    const write = result.writes[0]!;
    const returned =
      linked?.mirrors[tool] && write.appendedCount === 0
        ? await sendBack(write.targetSessionId)
        : 0;
    return { tool, write, returned };
  });
}

export async function createOpenCodeSeed(
  tool: Exclude<ToolName, "opencode">,
  path: string,
  cwd: string,
  allowIncompleteTools = false,
) {
  return buildOpenCodeSeed(
    tool,
    await loadSourceSessionSnapshot(tool, path),
    cwd,
    allowIncompleteTools,
  );
}

const importedOpenCodeModel = { providerID: "openai", id: "codex-import" };
const importedOpenCodeTokens = {
  input: 0,
  output: 0,
  reasoning: 0,
  cache: { read: 0, write: 0 },
};

class IncompleteOpenCodeToolHistory extends Error {}

function renderOpenCodeHistory(
  chunks: SourceMessageChunk[],
  idForOffset: (offset: number) => string,
  allowIncompleteTools = false,
) {
  const pendingCalls = new Set<string>();
  const messages = chunks.map(({ message, sourceOffset }) => {
    const content = message.content.map((block) => {
      if (block.type === "text") return block;
      if (block.type === "thinking")
        return { type: "text" as const, text: "[Source reasoning omitted]" };
      if (block.type === "image")
        return {
          type: "text" as const,
          text: "[Source image omitted; see the original session]",
        };
      let issue: string | undefined;
      if (block.type === "tool_call") {
        if (pendingCalls.has(block.id)) issue = "Duplicate tool call";
        pendingCalls.add(block.id);
      } else if (block.type === "tool_result") {
        if (!pendingCalls.delete(block.toolCallId))
          issue = "Tool result without a matching call";
      }
      if (issue && !allowIncompleteTools)
        throw new IncompleteOpenCodeToolHistory(
          `${issue} in OpenCode transcript`,
        );
      return {
        type: "text" as const,
        text:
          (allowIncompleteTools
            ? `Historical tool record (${issue ?? "status unverified"}): `
            : "Historical tool record (already settled): ") +
          JSON.stringify(block),
      };
    });
    if (!content.length)
      content.push({ type: "text", text: "[Empty source message]" });
    const id = idForOffset(sourceOffset);
    const created = Date.parse(message.timestamp);
    if (!Number.isFinite(created))
      throw new Error("Invalid source message time");
    return message.role === "user" &&
      !message.content.every((item) => item.type === "tool_result")
      ? {
          id,
          type: "user" as const,
          time: { created },
          text: content.map((item) => item.text).join("\n"),
        }
      : {
          id,
          type: "assistant" as const,
          time: { created, completed: created },
          agent: "build",
          model: {
            id: importedOpenCodeModel.id,
            providerID: importedOpenCodeModel.providerID,
          },
          content,
          finish: "stop",
          cost: 0,
          tokens: importedOpenCodeTokens,
        };
  });
  if (pendingCalls.size && !allowIncompleteTools)
    throw new IncompleteOpenCodeToolHistory(
      "Unsettled tool calls in OpenCode transcript",
    );
  return messages;
}

function buildOpenCodeSeed(
  tool: Exclude<ToolName, "opencode">,
  snapshot: SourceSessionSnapshot,
  cwd: string,
  allowIncompleteTools = false,
) {
  if (!snapshot.chunks.length)
    throw new Error("Source session has no supported messages");
  if (tool === "codex" && !isCodexThreadId(snapshot.sourceSessionId)) {
    throw new Error("OpenCode sync requires a native Codex thread ID");
  }
  const seed = `${tool}:${snapshot.sourceSessionId}`;
  const id = "ses_" + deterministicUuid(seed).replaceAll("-", "");
  const idForOffset = (offset: number) =>
    "msg_" + deterministicUuid(`${seed}:${offset}`).replaceAll("-", "");
  let messages;
  try {
    messages = renderOpenCodeHistory(snapshot.chunks, idForOffset);
  } catch (error) {
    if (
      !allowIncompleteTools ||
      !(error instanceof IncompleteOpenCodeToolHistory)
    )
      throw error;
    messages = renderOpenCodeHistory(snapshot.chunks, idForOffset, true);
  }
  const created = messages[0]!.time.created;
  return {
    info: {
      id,
      projectID: "global",
      title: "Imported " + tool + " conversation",
      agent: "build",
      model: importedOpenCodeModel,
      tokens: importedOpenCodeTokens,
      cost: 0,
      location: { directory: cwd },
      time: {
        created,
        updated: messages.reduce(
          (latest, message) => Math.max(latest, message.time.created),
          created,
        ),
      },
    },
    messages,
  };
}

export async function readSeedSourceId(
  tool: Exclude<ToolName, "opencode">,
  path: string,
): Promise<string | undefined> {
  for await (const record of iterateCodexRollout(path)) {
    const item = record as unknown as {
      type: string;
      id?: unknown;
      sessionId?: unknown;
      payload?: { id?: unknown };
    };
    const id =
      tool === "claude"
        ? item.sessionId
        : tool === "pi" && item.type === "session"
          ? item.id
          : tool === "codex" && item.type === "session_meta"
            ? item.payload?.id
            : undefined;
    if (typeof id === "string") return id;
  }
}

export async function seedLinkedSessionInOpenCode(params: {
  tool: Exclude<ToolName, "opencode">;
  sourcePath: string;
  expectedSourceId?: string;
  cwd?: string;
  fallbackCwd?: string;
  allowIncompleteTools?: boolean;
  databasePath: string;
  registryPath: string;
  importVerified: (
    bundle: ReturnType<typeof buildOpenCodeSeed>,
    alreadyLinked: boolean,
  ) => Promise<void>;
}) {
  return withRegistryWriteLock(params.registryPath, async () => {
    const { tool } = params;
    const source = await loadSourceSessionSnapshot(tool, params.sourcePath);
    if (
      params.expectedSourceId &&
      source.sourceSessionId !== params.expectedSourceId
    )
      throw new Error("Source session identity changed during backfill");

    const cwd =
      params.cwd ??
      (await realpath(source.cwd).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT" && params.fallbackCwd)
          return params.fallbackCwd;
        if (error.code === "ENOENT")
          throw new Error(
            "Source project directory is missing; supply --target-cwd with an existing fallback",
            { cause: error },
          );
        throw error;
      }));
    if (!(await stat(cwd)).isDirectory())
      throw new Error("Source project must be a directory");
    const bundle = buildOpenCodeSeed(
      tool,
      source,
      cwd,
      params.allowIncompleteTools,
    );
    const registry = await loadRegistry(params.registryPath, { readFile });
    const linked = findConversationByNativeSession(
      registry,
      tool,
      source.sourceSessionId,
    );
    const existing = findConversationByNativeSession(
      registry,
      "opencode",
      bundle.info.id,
    );
    if (
      (linked?.mirrors.opencode &&
        linked.mirrors.opencode.nativeId !== bundle.info.id) ||
      (linked?.mirrors.opencode?.openCodeDatabasePath &&
        linked.mirrors.opencode.openCodeDatabasePath !== params.databasePath) ||
      (existing && existing.bridgeSessionId !== linked?.bridgeSessionId) ||
      (linked && linked.canonicalCwd !== cwd) ||
      (linked?.mirrors[tool]?.sessionPath &&
        linked.mirrors[tool].sessionPath !== params.sourcePath)
    ) {
      throw new Error(
        "Source or destination already belongs to a different bridge link",
      );
    }
    await params.importVerified(bundle, Boolean(existing));
    if (existing) return bundle;

    const { projectKey, canonicalCwd } = await deriveProjectKey(cwd, {
      realpath,
      findRepoRoot: async (cwd) => findGitRepoRoot(cwd, { exists }),
    });
    const conversation =
      linked ??
      createConversation(
        projectKey,
        canonicalCwd,
        tool,
        source.sourceSessionId,
        params.sourcePath,
        source.updatedAt,
      );
    const offset = source.chunks.at(-1)!.sourceOffset;
    conversation.mirrors[tool]!.seedPrefix = {
      offset,
      digest: sourcePrefixDigest(source, offset),
    };
    conversation.mirrors.opencode = {
      seedTool: tool,
      openCodeDatabasePath: params.databasePath,
      sessionPath: params.databasePath,
      nativeId: bundle.info.id,
      seededSourceOffset: bundle.messages.length,
      exportPrefix: {
        count: bundle.messages.length,
        digest: chunkDigest(normalizeOpenCodeMessages(bundle.messages)),
        linkedOffset: offset,
        lastNativeOffset: 0,
      },
    };
    await saveRegistry(
      params.registryPath,
      upsertConversation(registry, conversation),
      {
        mkdir: async (path, options) => {
          await mkdir(path, options);
        },
        writeFile,
        rename,
      },
    );
    return bundle;
  });
}

function sourcePrefixDigest(
  snapshot: SourceSessionSnapshot,
  offset: number,
): string {
  return chunkDigest(
    snapshot.chunks.filter((chunk) => chunk.sourceOffset <= offset),
  );
}

function chunkDigest(chunks: Iterable<SourceMessageChunk>): string {
  const hash = createHash("sha256").update("[");
  let first = true;
  for (const chunk of chunks) {
    if (!first) hash.update(",");
    first = false;
    hash.update(JSON.stringify(chunk));
  }
  return hash.update("]").digest("hex");
}

function verifySeedPrefix(
  mirror: ToolMirror,
  snapshot: SourceSessionSnapshot,
): void {
  const prefix = mirror.seedPrefix;
  if (prefix && prefix.digest !== sourcePrefixDigest(snapshot, prefix.offset)) {
    throw new Error(
      `Original ${snapshot.sourceTool === "codex" ? "Codex" : snapshot.sourceTool} seed history diverged`,
    );
  }
}

async function resolveLinkedSessionPath(
  tool: Exclude<ToolName, "opencode">,
  mirror: ToolMirror,
): Promise<string> {
  if (
    tool !== "codex" ||
    !mirror.seedPrefix ||
    !mirror.sessionPath.endsWith(".jsonl.zst")
  )
    return mirror.sessionPath;
  const reopened = mirror.sessionPath.slice(0, -4);
  const candidate = await lstat(reopened).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    },
  );
  return candidate?.isFile() ? reopened : mirror.sessionPath;
}

async function returnLinkedTurnsUnderLock(params: {
  registryPath: string;
  tool: Exclude<ToolName, "opencode">;
  sessionId: string;
  databasePath: string;
  version: string;
}): Promise<number> {
  const { readOpenCodeRows, appendOpenCodeMessages } =
    await import("./opencode-store.js");
  const registry = await loadRegistry(params.registryPath, { readFile });
  const conversation = findConversationByNativeSession(
    registry,
    params.tool,
    params.sessionId,
  );
  const source = conversation?.mirrors[params.tool];
  const target = conversation?.mirrors.opencode;
  if (
    !source ||
    !target?.exportPrefix ||
    (target.seedTool ?? "codex") !== params.tool ||
    (target.openCodeDatabasePath &&
      target.openCodeDatabasePath !== (await realpath(params.databasePath)))
  ) {
    throw new Error("Expected a linked OpenCode session");
  }
  if (
    getMaxSyncedSourceOffset(
      conversation.lastWrittenOffsets,
      "opencode",
      target.nativeId,
      params.tool,
      source.nativeId,
    ) !== (target.exportPrefix.lastNativeOffset ?? target.exportPrefix.count)
  ) {
    throw new Error(
      "Linked session must contain the latest imported OpenCode history",
    );
  }
  const snapshot = await loadSourceSessionSnapshot(
    params.tool,
    await resolveLinkedSessionPath(params.tool, source),
  );
  if (snapshot.sourceSessionId !== params.sessionId)
    throw new Error("Linked session identity changed");
  verifySeedPrefix(source, snapshot);
  const turns = snapshot.chunks.filter(
    (chunk) =>
      chunk.sourceOffset > linkedImportOffset(conversation, params.tool),
  );
  const { rows, cursor } = readOpenCodeRows(
    params.databasePath,
    params.version,
    target.nativeId,
  );
  const { count, digest } = target.exportPrefix;
  if (rows.length < count) throw new Error("OpenCode history diverged");
  const prefix = (function* () {
    for (let index = 0; index < count; index++) {
      const row = rows[index]!;
      yield* normalizeOpenCodeMessages(
        [
          {
            ...JSON.parse(row.data),
            type: row.type,
            id: row.id,
          },
        ],
        index,
      );
    }
  })();
  if (chunkDigest(prefix) !== digest) {
    throw new Error("OpenCode history diverged");
  }
  const existing = rows.slice(count);
  if (existing.length > turns.length)
    throw new Error("OpenCode history diverged");
  const records = renderOpenCodeHistory(turns, (offset) =>
    returnedOpenCodeId(source.nativeId, offset, target.nativeId),
  );
  const pending = [];
  for (const [index, { id, type, ...body }] of records.entries()) {
    const time = body.time.created;
    const data = JSON.stringify(body);
    const prior = existing[index];
    if (prior) {
      if (prior.id !== id || prior.type !== type || prior.data !== data)
        throw new Error("OpenCode history diverged");
    } else {
      pending.push({
        id,
        type,
        time_created: time,
        time_updated: time,
        seq: Math.max(cursor, rows.at(-1)?.seq ?? 0) + pending.length + 1,
        data,
      });
    }
  }
  if (!pending.length) return 0;
  return appendOpenCodeMessages(
    params.databasePath,
    params.version,
    target.nativeId,
    rows,
    pending,
  );
}

export async function loadOpenCodeDatabaseSnapshot(
  path: string,
  version: string,
  id: string,
): Promise<SourceSessionSnapshot> {
  const { visitOpenCodeSessionRows } = await import("./opencode-store.js");
  const chunks: SourceMessageChunk[] = [];
  let rawMessageCount = 0;
  let omittedSystemRecords = 0;
  const session = visitOpenCodeSessionRows(path, version, id, (entry) => {
    if ((entry as { type: string }).type === "system")
      omittedSystemRecords += 1;
    const [chunk] = normalizeOpenCodeMessages([entry], rawMessageCount++);
    if (chunk) chunks.push(chunk);
  });
  return {
    sourceTool: "opencode",
    sourcePath: path,
    sourceSessionId: id,
    cwd: session.directory,
    updatedAt: session.updatedAt,
    chunks,
    rawMessageCount,
    omittedSystemRecords,
  };
}

async function syncSourceSessionUnderLock(params: {
  sourceTool: ToolName;
  sourcePath: string;
  sourceSessionId?: string;
  openCodeDatabaseVersion?: string;
  targetCwd?: string;
  registryPath: string;
  homeDir: string;
  now?: Date;
  targetTools?: ToolName[];
}): Promise<SyncSourceSessionResult> {
  if (params.targetTools?.includes("opencode")) {
    throw new Error("OpenCode target sync is not available");
  }
  const now = params.now ?? new Date();
  const snapshot =
    params.sourceTool === "opencode" &&
    params.openCodeDatabaseVersion &&
    params.sourceSessionId
      ? await loadOpenCodeDatabaseSnapshot(
          params.sourcePath,
          params.openCodeDatabaseVersion,
          params.sourceSessionId,
        )
      : await loadSourceSessionSnapshot(
          params.sourceTool,
          params.sourcePath,
          params.sourceSessionId,
        );
  if (params.openCodeDatabaseVersion && !snapshot.chunks.length)
    throw new Error("OpenCode session has no supported messages");
  const registry = await loadRegistry(params.registryPath, { readFile });
  const linked = findConversationByNativeSession(
    registry,
    params.sourceTool,
    snapshot.sourceSessionId,
  );
  const mirrorCwd =
    params.targetCwd ??
    (params.sourceTool === "opencode" ? linked?.canonicalCwd : undefined) ??
    snapshot.cwd;
  const { canonicalCwd, projectKey } = await deriveProjectKey(mirrorCwd, {
    realpath,
    findRepoRoot: async (cwd) => findGitRepoRoot(cwd, { exists }),
  }).catch((error: NodeJS.ErrnoException) => {
    if (params.sourceTool === "opencode" && error.code === "ENOENT") {
      throw new Error(
        params.targetCwd
          ? "Target project directory is missing"
          : "Source project directory is missing; supply --target-cwd with an existing project",
        { cause: error },
      );
    }
    throw error;
  });
  if (
    params.targetCwd &&
    (!(await stat(canonicalCwd)).isDirectory() ||
      (linked && linked.canonicalCwd !== canonicalCwd))
  ) {
    throw new Error(
      "Target project must be a directory and match the existing mirror location",
    );
  }

  let conversation =
    linked ??
    createConversation(
      projectKey,
      canonicalCwd,
      params.sourceTool,
      snapshot.sourceSessionId,
      params.sourcePath,
      now.toISOString(),
    );

  const seededSourceOffset =
    conversation.mirrors[params.sourceTool]?.nativeId ===
    snapshot.sourceSessionId
      ? conversation.mirrors[params.sourceTool]?.seededSourceOffset
      : undefined;
  const sourceChunks =
    typeof seededSourceOffset === "number"
      ? snapshot.chunks.filter(
          (chunk) => chunk.sourceOffset > seededSourceOffset,
        )
      : snapshot.chunks;
  let authoredSourceChunks = sourceChunks.filter(
    (chunk) =>
      !isImportedMirrorChunk({
        watermarks: conversation.lastWrittenOffsets,
        sourceTool: params.sourceTool,
        sourceSessionId: snapshot.sourceSessionId,
        sourceOffset: chunk.sourceOffset,
      }),
  );

  conversation = attachSourceMirror(
    conversation,
    params.sourceTool,
    snapshot.sourceSessionId,
    params.sourcePath,
    snapshot.updatedAt,
  );

  if (params.sourceTool === "opencode") {
    const mirror = conversation.mirrors.opencode!;
    if (params.openCodeDatabaseVersion) {
      if (
        mirror.openCodeDatabasePath &&
        mirror.openCodeDatabasePath !== params.sourcePath
      )
        throw new Error("OpenCode session is linked to a different database");
      mirror.openCodeDatabasePath = params.sourcePath;
    }
    const digest = (count: number) => sourcePrefixDigest(snapshot, count);
    const prefix = mirror.exportPrefix;
    if (
      prefix &&
      (prefix.count > snapshot.rawMessageCount! ||
        prefix.digest !== digest(prefix.count))
    ) {
      throw new Error("OpenCode export history diverged");
    }
    const suffix = snapshot.chunks.filter(
      (chunk) => chunk.sourceOffset > (prefix?.count ?? 0),
    );
    const returned = suffix.filter(({ message }) =>
      message.id.startsWith(returnedOpenCodePrefix),
    );
    const tool = mirror.seedTool ?? "codex";
    const linkedMirror = conversation.mirrors[tool];
    if (
      mirror.seedTool &&
      params.targetTools &&
      !params.targetTools.includes(tool)
    )
      throw new Error(
        `OpenCode seed must sync with its original ${tool} session`,
      );
    let linkedOffset = linkedImportOffset(conversation, tool);
    if ((suffix.length || linkedMirror?.seedPrefix) && linkedMirror) {
      const linkedPath = await resolveLinkedSessionPath(tool, linkedMirror);
      const linkedSnapshot = await loadSourceSessionSnapshot(tool, linkedPath);
      if (linkedSnapshot.sourceSessionId !== linkedMirror.nativeId)
        throw new Error("Linked session identity changed");
      verifySeedPrefix(linkedMirror, linkedSnapshot);
      linkedMirror.sessionPath = linkedPath;
      const pending = linkedSnapshot.chunks.filter(
        (chunk) => chunk.sourceOffset > linkedOffset,
      );
      if (suffix.length) {
        const expected =
          pending.length === returned.length
            ? normalizeOpenCodeMessages(
                renderOpenCodeHistory(pending, (offset) =>
                  returnedOpenCodeId(
                    linkedMirror.nativeId,
                    offset,
                    mirror.nativeId,
                  ),
                ),
              )
            : [];
        if (
          pending.length !== returned.length ||
          expected.some(
            ({ message }, index) =>
              JSON.stringify(message) !==
              JSON.stringify(returned[index]?.message),
          )
        ) {
          throw new Error(
            `OpenCode and ${tool === "codex" ? "Codex" : tool} histories diverged`,
          );
        }
      }
      if (suffix.length)
        linkedOffset = pending.at(-1)?.sourceOffset ?? linkedOffset;
    } else if (returned.length) {
      throw new Error("OpenCode export contains unlinked returned turns");
    }
    authoredSourceChunks = authoredSourceChunks.filter(
      ({ message }) => !message.id.startsWith(returnedOpenCodePrefix),
    );
    mirror.exportPrefix = {
      count: snapshot.rawMessageCount!,
      digest: digest(snapshot.rawMessageCount!),
      linkedOffset,
      lastNativeOffset: authoredSourceChunks.at(-1)?.sourceOffset ?? 0,
    };
  }

  const targetTools = (params.targetTools ?? ["pi", "claude", "codex"]).filter(
    (tool) => tool !== params.sourceTool,
  );
  const writes: SyncWriteResult[] = [];

  for (const targetTool of targetTools) {
    const seedTool = conversation.mirrors.opencode?.seedTool;
    const initialCrossHarnessHistory =
      params.sourceTool === "opencode" &&
      seedTool &&
      targetTool !== seedTool &&
      !conversation.mirrors[targetTool];
    const mirror = await ensureTargetMirror(
      conversation,
      targetTool,
      params.homeDir,
      now,
    );
    conversation = {
      ...conversation,
      mirrors: {
        ...conversation.mirrors,
        [targetTool]: mirror,
      },
    };

    const targetSourceOffset = getMaxSyncedSourceOffset(
      conversation.lastWrittenOffsets,
      params.sourceTool,
      snapshot.sourceSessionId,
      targetTool,
      mirror.nativeId,
    );
    const targetChunks = (
      initialCrossHarnessHistory ? snapshot.chunks : authoredSourceChunks
    ).filter((chunk) => chunk.sourceOffset > targetSourceOffset);

    const writeResult =
      targetTool === "pi"
        ? await appendToPiMirror(
            mirror,
            mirrorCwd,
            params.sourceTool,
            snapshot.sourceSessionId,
            targetChunks,
            conversation.lastWrittenOffsets,
          )
        : targetTool === "claude"
          ? await appendToClaudeMirror(
              mirror,
              mirrorCwd,
              params.sourceTool,
              snapshot.sourceSessionId,
              targetChunks,
              conversation.lastWrittenOffsets,
            )
          : await appendToCodexMirror(
              mirror,
              mirrorCwd,
              params.homeDir,
              params.sourceTool,
              snapshot.sourceSessionId,
              targetChunks,
              conversation.lastWrittenOffsets,
            );

    conversation = {
      ...conversation,
      lastWrittenOffsets: writeResult.nextWatermarks,
      updatedAt: snapshot.updatedAt,
      mirrors:
        mirror.seededSourceOffset == null
          ? {
              ...conversation.mirrors,
              [targetTool]: {
                ...mirror,
                seededSourceOffset: writeResult.finalCount,
              },
            }
          : conversation.mirrors,
    };

    writes.push({
      targetTool,
      sessionPath: mirror.sessionPath,
      targetSessionId: mirror.nativeId,
      appendedCount: writeResult.appendedCount,
    });
  }

  const nextRegistry = upsertConversation(registry, conversation);
  await saveRegistry(params.registryPath, nextRegistry, {
    mkdir: async (path, options) => {
      await mkdir(path, options);
    },
    writeFile: async (path, data) => {
      await writeFile(path, data, "utf8");
    },
    rename,
  });

  return {
    conversation,
    registry: nextRegistry,
    writes,
    snapshot,
  };
}

async function readCandidateCwd(
  tool: ToolName,
  path: string,
): Promise<string | null> {
  try {
    if (tool === "pi") {
      return (await readPiSession(path)).header.cwd;
    }
    if (tool === "claude") {
      const lines = await readClaudeCodeSession(path);
      return lines.find((line) => typeof line.cwd === "string")?.cwd ?? null;
    }
    const items = await readCodexRollout(path);
    const meta = items.find((item) => item.type === "session_meta");
    return typeof meta?.payload.cwd === "string" ? meta.payload.cwd : null;
  } catch {
    return null;
  }
}

async function readSessionCandidate(
  tool: ToolName,
  path: string,
  canonicalProjectKey: string,
): Promise<SessionCandidate | null> {
  try {
    if (tool === "pi") {
      const session = await readPiSession(path);
      if (!(await belongsToProject(session.header.cwd, canonicalProjectKey))) {
        return null;
      }
      return {
        id: session.header.id,
        path,
        sourceTool: "pi",
        updatedAt:
          session.entries.at(-1)?.timestamp ?? session.header.timestamp,
      };
    }

    if (tool === "claude") {
      const cwd = await readCandidateCwd("claude", path);
      if (!cwd || !(await belongsToProject(cwd, canonicalProjectKey))) {
        return null;
      }
      const lines = await readClaudeCodeSession(path);
      return {
        id:
          lines.find((line) => typeof line.sessionId === "string")?.sessionId ??
          deterministicUuid(path),
        path,
        sourceTool: "claude",
        updatedAt:
          lines
            .map((line) => getClaudeLineTimestamp(line))
            .filter((value): value is string => Boolean(value))
            .at(-1) ?? new Date(0).toISOString(),
      };
    }

    const cwd = await readCandidateCwd("codex", path);
    if (!cwd || !(await belongsToProject(cwd, canonicalProjectKey))) {
      return null;
    }
    const items = await readCodexRollout(path);
    const meta = items.find((item) => item.type === "session_meta");
    return {
      id:
        (typeof meta?.payload.id === "string" ? meta.payload.id : undefined) ??
        deterministicUuid(path),
      path,
      sourceTool: "codex",
      updatedAt:
        items
          .map((item) => getCodexItemTimestamp(item))
          .filter((value): value is string => Boolean(value))
          .at(-1) ?? new Date(0).toISOString(),
    };
  } catch {
    return null;
  }
}

function isSessionCandidate(
  candidate: SessionCandidate | null,
): candidate is SessionCandidate {
  return candidate !== null;
}

async function canonicalizeForComparison(path: string): Promise<string> {
  try {
    return normalizePath(await realpath(path));
  } catch {
    return normalizePath(path);
  }
}

async function belongsToProject(
  candidateCwd: string,
  projectKey: string,
): Promise<boolean> {
  const normalizedProject = await canonicalizeForComparison(projectKey);
  const normalizedCandidate = await canonicalizeForComparison(candidateCwd);

  return (
    normalizedCandidate === normalizedProject ||
    normalizedCandidate.startsWith(`${normalizedProject}/`)
  );
}

export async function listSessionCandidatesForProject(
  tool: ToolName,
  projectKey: string,
  homeDir: string,
): Promise<SessionCandidate[]> {
  const canonicalProjectKey = await canonicalizeForComparison(projectKey);
  const files =
    tool === "pi"
      ? await walkJsonlFiles(join(homeDir, ".pi", "agent", "sessions"))
      : tool === "claude"
        ? await walkJsonlFiles(join(homeDir, ".claude", "projects"))
        : await walkJsonlFiles(join(homeDir, ".codex", "sessions"));
  const candidates = (
    await Promise.all(
      files.map((path) =>
        readSessionCandidate(tool, path, canonicalProjectKey),
      ),
    )
  )
    .filter(isSessionCandidate)
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));

  return candidates;
}

export async function listForeignSessionCandidates(
  projectKey: string,
  homeDir: string,
  targetTool?: ToolName,
): Promise<SessionCandidate[]> {
  const tools: ToolName[] = ["pi", "claude", "codex"];
  const groups = await Promise.all(
    tools
      .filter((tool) => tool !== targetTool)
      .map((tool) =>
        listSessionCandidatesForProject(tool, projectKey, homeDir),
      ),
  );

  return groups
    .flat()
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

export async function importLatestSessionToTarget(params: {
  targetTool: ToolName;
  cwd: string;
  homeDir: string;
  registryPath: string;
  now?: Date;
  dryRun?: boolean;
}): Promise<{
  imported: boolean;
  candidate: SessionCandidate | null;
  result?: SyncSourceSessionResult;
}> {
  const { projectKey } = await deriveProjectKey(params.cwd, {
    realpath,
    findRepoRoot: async (cwd) =>
      findGitRepoRoot(cwd, {
        exists,
      }),
  });
  const registry = await loadRegistry(params.registryPath, { readFile });
  const linkedConversations = findConversationsByProjectKey(
    registry,
    projectKey,
  ).sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  const linkedConversation =
    linkedConversations.length === 1 ? linkedConversations[0] : undefined;
  const candidates = await listForeignSessionCandidates(
    projectKey,
    params.homeDir,
    params.targetTool,
  );
  const candidate = selectImportCandidate(candidates, linkedConversation);

  if (!candidate) {
    return { imported: false, candidate: null };
  }

  if (params.dryRun) return { imported: false, candidate };

  const result = await syncSourceSessionToTargets({
    sourceTool: candidate.sourceTool,
    sourcePath: candidate.path,
    sourceSessionId: candidate.id,
    registryPath: params.registryPath,
    homeDir: params.homeDir,
    now: params.now,
    targetTools: [params.targetTool],
  });

  return {
    imported: true,
    candidate,
    result,
  };
}
