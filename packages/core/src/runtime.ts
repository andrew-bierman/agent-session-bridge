import {
  access,
  appendFile,
  mkdir,
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

async function appendJsonLines(path: string, items: unknown[]): Promise<void> {
  if (items.length === 0) {
    return;
  }
  await mkdir(dirname(path), { recursive: true });
  await appendFile(
    path,
    `${items.map((item) => JSON.stringify(item)).join("\n")}\n`,
    "utf8",
  );
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

  const createdAtSeconds = Math.floor(Date.parse(params.createdAt) / 1000);
  const updatedAtSeconds = Math.floor(Date.parse(params.updatedAt) / 1000);
  const requestedAssignments = [
    buildSqlAssignment("id", params.threadId),
    buildSqlAssignment("rollout_path", params.rolloutPath),
    buildSqlAssignment("created_at", createdAtSeconds),
    buildSqlAssignment("updated_at", updatedAtSeconds),
    buildSqlAssignment("source", "vscode"),
    buildSqlAssignment("model_provider", "openai"),
    buildSqlAssignment("cwd", params.cwd),
    buildSqlAssignment("title", params.title),
    buildSqlAssignment("sandbox_policy", "workspace-write"),
    buildSqlAssignment("approval_mode", "never"),
    buildSqlAssignment("tokens_used", 0),
    buildSqlAssignment(
      "has_user_event",
      params.firstUserMessage.length > 0 ? 1 : 0,
    ),
    buildSqlAssignment("archived", 0),
    buildSqlAssignment("cli_version", "0.115.0"),
    buildSqlAssignment("first_user_message", params.firstUserMessage),
    buildSqlAssignment("memory_mode", "enabled"),
    buildSqlAssignment("model", "gpt-5.4"),
    buildSqlAssignment("reasoning_effort", "medium"),
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
    await execFile("sqlite3", [dbPath, sql]);
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

  const items = await readCodexRollout(path);
  return {
    count: items.length,
    hasMeta: items.some((item) => item.type === "session_meta"),
  };
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
        (part: any) => part?.type !== "text" || typeof part.text !== "string",
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
            ? { output: state.content.map((part: any) => part.text) }
            : { error: state.error }),
        }),
    },
  ];
}

function normalizeOpenCodeMessages(messages: any[]): SourceMessageChunk[] {
  return messages.flatMap((entry, index) => {
    if (
      entry?.type === "agent-switched" ||
      entry?.type === "idle" ||
      entry?.type === "model-switched" ||
      entry?.type === "system"
    )
      return [];
    const historical =
      entry?.type === "synthetic" && typeof entry.text === "string"
        ? "Historical OpenCode synthetic record: " + JSON.stringify(entry.text)
        : entry?.type === "compaction" &&
            entry.status === "completed" &&
            typeof entry.summary === "string"
          ? "Historical OpenCode compaction summary: " +
            JSON.stringify(entry.summary)
          : undefined;
    const blocks =
      historical !== undefined
        ? [{ type: "text", text: historical }]
        : entry?.type === "user" && !entry.files?.length
          ? [{ type: "text", text: entry.text }]
          : entry?.type === "assistant"
            ? entry.content
            : null;
    if (
      entry?.error ||
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
        sourceOffset: index + 1,
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

    return {
      sourceTool,
      sourcePath,
      sourceSessionId,
      cwd,
      updatedAt: timestamps.at(-1) ?? info.mtime.toISOString(),
      chunks: lines.flatMap((line, index) => {
        const normalized = convertClaudeLineToNormalized(line);
        return normalized
          ? [{ sourceOffset: index + 1, message: normalized }]
          : [];
      }),
    };
  }

  const items = await readCodexRollout(sourcePath);
  const sessionMeta = items.find((item) => item.type === "session_meta");
  const sourceSessionId =
    explicitSessionId ??
    (typeof sessionMeta?.payload.id === "string"
      ? sessionMeta.payload.id
      : undefined) ??
    deterministicUuid(sourcePath);
  const cwd =
    (typeof sessionMeta?.payload.cwd === "string"
      ? sessionMeta.payload.cwd
      : undefined) ?? "/";
  const timestamps = items
    .map((item) => getCodexItemTimestamp(item))
    .filter((value): value is string => Boolean(value));

  return {
    sourceTool,
    sourcePath,
    sourceSessionId,
    cwd,
    updatedAt: timestamps.at(-1) ?? info.mtime.toISOString(),
    chunks: items.flatMap((item, index) => {
      const normalized = convertCodexItemToNormalized(item);
      return normalized
        ? [{ sourceOffset: index + 1, message: normalized }]
        : [];
    }),
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

    await appendJsonLines(mirror.sessionPath, [entry]);
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

    await appendJsonLines(mirror.sessionPath, [line]);
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
      await appendJsonLines(mirror.sessionPath, [
        {
          timestamp: chunks[0]!.message.timestamp,
          ...sessionMeta,
        },
      ]);
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

    await appendJsonLines(mirror.sessionPath, lines);
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

export async function createOpenCodeSeed(
  tool: Exclude<ToolName, "opencode">,
  path: string,
  cwd: string,
) {
  return buildOpenCodeSeed(
    tool,
    await loadSourceSessionSnapshot(tool, path),
    cwd,
  );
}

const importedOpenCodeModel = { providerID: "openai", id: "codex-import" };
const importedOpenCodeTokens = {
  input: 0,
  output: 0,
  reasoning: 0,
  cache: { read: 0, write: 0 },
};

function renderOpenCodeHistory(
  chunks: SourceMessageChunk[],
  idForOffset: (offset: number) => string,
) {
  const pendingCalls = new Set<string>();
  const messages = chunks.map(({ message, sourceOffset }) => {
    const content = message.content.map((block) => {
      if (block.type === "text") return block;
      if (block.type === "tool_call") {
        if (pendingCalls.has(block.id))
          throw new Error("Duplicate tool call in OpenCode transcript");
        pendingCalls.add(block.id);
      } else if (block.type === "tool_result") {
        if (!pendingCalls.delete(block.toolCallId))
          throw new Error(
            "Tool result without a matching call in OpenCode transcript",
          );
      } else {
        throw new Error(
          `Unsupported OpenCode transcript content: ${block.type}`,
        );
      }
      return {
        type: "text" as const,
        text:
          "Historical tool record (already settled): " + JSON.stringify(block),
      };
    });
    if (!content.length)
      throw new Error("Empty message in OpenCode transcript");
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
  if (pendingCalls.size)
    throw new Error("Unsettled tool calls in OpenCode transcript");
  return messages;
}

function buildOpenCodeSeed(
  tool: Exclude<ToolName, "opencode">,
  snapshot: SourceSessionSnapshot,
  cwd: string,
) {
  if (!snapshot.chunks.length)
    throw new Error("Source session has no supported messages");
  const seed = `${tool}:${snapshot.sourceSessionId}`;
  const id = "ses_" + deterministicUuid(seed).replaceAll("-", "");
  const messages = renderOpenCodeHistory(
    snapshot.chunks,
    (sourceOffset) =>
      "msg_" + deterministicUuid(`${seed}:${sourceOffset}`).replaceAll("-", ""),
  );
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

export async function seedLinkedSessionInOpenCode(params: {
  tool: Exclude<ToolName, "opencode">;
  sourcePath: string;
  cwd: string;
  databasePath: string;
  registryPath: string;
  importVerified: (
    bundle: ReturnType<typeof buildOpenCodeSeed>,
  ) => Promise<void>;
}): Promise<void> {
  await withRegistryWriteLock(params.registryPath, async () => {
    const { tool } = params;
    const source = await loadSourceSessionSnapshot(tool, params.sourcePath);
    if (tool === "codex" && !isCodexThreadId(source.sourceSessionId)) {
      throw new Error("OpenCode sync requires a native Codex thread ID");
    }
    const bundle = buildOpenCodeSeed(tool, source, params.cwd);
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
      (existing && existing.bridgeSessionId !== linked?.bridgeSessionId) ||
      (linked && linked.canonicalCwd !== params.cwd) ||
      (linked?.mirrors[tool]?.sessionPath &&
        linked.mirrors[tool].sessionPath !== params.sourcePath)
    ) {
      throw new Error(
        "Source or destination already belongs to a different bridge link",
      );
    }
    await params.importVerified(bundle);
    if (existing) return;

    const { projectKey, canonicalCwd } = await deriveProjectKey(params.cwd, {
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
      sessionPath: params.databasePath,
      nativeId: bundle.info.id,
      seededSourceOffset: bundle.messages.length,
      exportPrefix: {
        count: bundle.messages.length,
        digest: createHash("sha256")
          .update(JSON.stringify(normalizeOpenCodeMessages(bundle.messages)))
          .digest("hex"),
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
  });
}

function sourcePrefixDigest(
  snapshot: SourceSessionSnapshot,
  offset: number,
): string {
  return createHash("sha256")
    .update(
      JSON.stringify(
        snapshot.chunks.filter((chunk) => chunk.sourceOffset <= offset),
      ),
    )
    .digest("hex");
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
    (target.seedTool ?? "codex") !== params.tool
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
    source.sessionPath,
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
  const prefix = normalizeOpenCodeMessages(
    rows.slice(0, count).map((row) => ({
      ...JSON.parse(row.data),
      type: row.type,
      id: row.id,
    })),
  );
  if (
    createHash("sha256").update(JSON.stringify(prefix)).digest("hex") !== digest
  ) {
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
  return appendOpenCodeMessages(
    params.databasePath,
    params.version,
    target.nativeId,
    rows,
    pending,
  );
}

async function syncSourceSessionUnderLock(params: {
  sourceTool: ToolName;
  sourcePath: string;
  sourceSessionId?: string;
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
  const snapshot = await loadSourceSessionSnapshot(
    params.sourceTool,
    params.sourcePath,
    params.sourceSessionId,
  );
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
    const digest = (count: number) =>
      createHash("sha256")
        .update(
          JSON.stringify(
            snapshot.chunks.filter((chunk) => chunk.sourceOffset <= count),
          ),
        )
        .digest("hex");
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
      const linkedSnapshot = await loadSourceSessionSnapshot(
        tool,
        linkedMirror.sessionPath,
      );
      if (linkedSnapshot.sourceSessionId !== linkedMirror.nativeId)
        throw new Error("Linked session identity changed");
      verifySeedPrefix(linkedMirror, linkedSnapshot);
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
    const targetChunks = authoredSourceChunks.filter(
      (chunk) => chunk.sourceOffset > targetSourceOffset,
    );

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
