import { DatabaseSync } from "node:sqlite";

export interface OpenCodeMessageRow {
  id: string;
  type: "user" | "assistant";
  seq: number;
  time_created: number;
  time_updated: number;
  data: string;
}

const fields = "id, type, seq, time_created, time_updated, data";

function sameRow(a: OpenCodeMessageRow, b: OpenCodeMessageRow): boolean {
  return (
    a.id === b.id &&
    a.type === b.type &&
    a.seq === b.seq &&
    a.time_created === b.time_created &&
    a.time_updated === b.time_updated &&
    a.data === b.data
  );
}

export function readOpenCodeRows(
  path: string,
  version: string,
  sessionId: string,
) {
  checkVersion(version);
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    db.exec("BEGIN");
    const rows = db
      .prepare(
        `SELECT ${fields} FROM session_message WHERE session_id = ? ORDER BY seq`,
      )
      .all(sessionId) as unknown as OpenCodeMessageRow[];
    const cursor = db
      .prepare("SELECT seq FROM event_sequence WHERE aggregate_id = ?")
      .get(sessionId)?.seq;
    if (typeof cursor !== "number")
      throw new Error("Missing OpenCode event sequence");
    return { rows, cursor };
  } finally {
    db.close();
  }
}

export function verifyOpenCodeSeedRows(
  path: string,
  version: string,
  sessionId: string,
  directory: string,
  expected: readonly ({
    id: string;
    time: { created: number };
  } & (
    | { type: "user"; text: string }
    | { type: "assistant"; content: unknown }
  ))[],
): boolean {
  checkVersion(version);
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    db.exec("BEGIN");
    const session = db
      .prepare("SELECT directory FROM session_v2 WHERE id = ?")
      .get(sessionId);
    if (session?.directory !== directory) return false;
    const rows = db
      .prepare(
        "SELECT id, type, data FROM session_message WHERE session_id = ? ORDER BY seq LIMIT ?",
      )
      .iterate(sessionId, expected.length);
    let offset = 0;
    for (const row of rows) {
      const message = expected[offset++]!;
      const data = JSON.parse(String(row.data));
      if (
        row.id !== message.id ||
        row.type !== message.type ||
        data.time?.created !== message.time.created ||
        (message.type === "user"
          ? data.text !== message.text
          : JSON.stringify(data.content) !== JSON.stringify(message.content))
      )
        return false;
    }
    return offset === expected.length;
  } finally {
    db.close();
  }
}

function checkVersion(version: string) {
  if (version !== "2.3.0" && version !== "2.3.2")
    throw new Error("Unsupported OpenCode version");
}

// shortcut: OpenCode 2.3 projection only; verify replay and live resume before wiring into sync.
export function appendOpenCodeMessages(
  path: string,
  version: string,
  sessionId: string,
  baseline: readonly OpenCodeMessageRow[],
  appended: readonly OpenCodeMessageRow[],
): number {
  checkVersion(version);
  const db = new DatabaseSync(path, { allowExtension: false });
  try {
    db.exec("PRAGMA foreign_keys = ON; BEGIN IMMEDIATE");
    if (!db.prepare("SELECT id FROM session_v2 WHERE id = ?").get(sessionId)) {
      throw new Error("OpenCode session does not exist");
    }
    const current = db
      .prepare(
        `SELECT ${fields} FROM session_message WHERE session_id = ? ORDER BY seq`,
      )
      .all(sessionId) as unknown as OpenCodeMessageRow[];
    const desired = [...baseline, ...appended];
    if (
      current.length === desired.length &&
      current.every((row, i) => sameRow(row, desired[i]!))
    ) {
      db.exec("COMMIT");
      return 0;
    }
    if (
      current.length !== baseline.length ||
      !current.every((row, i) => sameRow(row, baseline[i]!))
    ) {
      throw new Error("OpenCode session history diverged");
    }

    const insert = db.prepare(
      `INSERT INTO session_message (session_id, ${fields}) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    const cursor = db
      .prepare("SELECT seq FROM event_sequence WHERE aggregate_id = ?")
      .get(sessionId)?.seq;
    if (typeof cursor !== "number")
      throw new Error("Missing OpenCode event sequence");
    let seq = Math.max(cursor, baseline.at(-1)?.seq ?? 0);
    for (const row of appended) {
      if (row.seq !== ++seq)
        throw new Error("Invalid OpenCode message sequence");
      insert.run(
        sessionId,
        row.id,
        row.type,
        row.seq,
        row.time_created,
        row.time_updated,
        row.data,
      );
    }
    // Native imports reserve the same sequence range for their projected messages.
    db.prepare("UPDATE event_sequence SET seq = ? WHERE aggregate_id = ?").run(
      seq,
      sessionId,
    );
    db.exec("COMMIT");
    return appended.length;
  } finally {
    db.close();
  }
}
