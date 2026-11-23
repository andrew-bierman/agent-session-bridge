#!/usr/bin/env bun
// Copy Codex rollouts created by Omnigent's private per-session CODEX_HOMEs into
// the native Codex home and index them so they show up in `codex resume`.
//
// Usage:
//   bun scripts/omnigent-codex-sync.ts --omnigent-data <dir> [--codex-home ~/.codex] [--apply]
//
// Dry run by default. With --apply it backs up the target state_N.sqlite first.
// Runs straight from TypeScript source; requires bun and the sqlite3 CLI.
import { copyFile, mkdir, readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { backfillCodexThreadIndex } from "../packages/core/src/runtime.js";

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(name);
const opt = (name: string, fallback: string) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};

const omnigentData = resolve(
  opt("--omnigent-data", process.env.OMNIGENT_DATA_DIR ?? join(homedir(), ".omnigent")),
);
const codexHome = resolve(opt("--codex-home", join(homedir(), ".codex")));
const apply = flag("--apply");

async function* walk(dir: string): AsyncGenerator<string> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) yield* walk(p);
    else yield p;
  }
}

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

type SessionMeta = { id: string; cwd: string; timestamp?: string };

async function sessionMeta(rolloutPath: string): Promise<SessionMeta | null> {
  const text = await readFile(rolloutPath, "utf8");
  for (const line of text.split("\n").slice(0, 50)) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      if (entry.type === "session_meta" && entry.payload?.id) {
        return { id: entry.payload.id, cwd: entry.payload.cwd, timestamp: entry.payload.timestamp };
      }
    } catch {
      // ignore malformed line
    }
  }
  return null;
}

const found: string[] = [];
for await (const p of walk(omnigentData)) {
  if (/rollout-.*\.jsonl$/.test(basename(p)) && p.includes("codex-home")) found.push(p);
}

if (apply) {
  const dbs = (await readdir(codexHome)).filter((f) => /^state_\d+\.sqlite$/.test(f)).sort();
  const newest = dbs.at(-1);
  if (newest) {
    const backup = join(codexHome, `${newest}.bak-${Date.now()}`);
    await copyFile(join(codexHome, newest), backup);
    console.log(`backed up ${newest} -> ${backup}`);
  }
}

let copied = 0;
let skipped = 0;
for (const src of found) {
  const meta = await sessionMeta(src);
  if (!meta) {
    console.log(`skip (no session_meta): ${src}`);
    skipped++;
    continue;
  }
  const d = new Date(meta.timestamp ?? Date.now());
  const dest = join(
    codexHome,
    "sessions",
    String(d.getUTCFullYear()),
    String(d.getUTCMonth() + 1).padStart(2, "0"),
    String(d.getUTCDate()).padStart(2, "0"),
    basename(src),
  );
  if (await exists(dest)) {
    console.log(`skip (already present): ${meta.id}`);
    skipped++;
    continue;
  }
  console.log(`${apply ? "sync" : "would sync"}: ${meta.id}  ${meta.cwd}`);
  if (!apply) continue;
  await mkdir(join(dest, ".."), { recursive: true });
  await copyFile(src, dest);
  const result = await backfillCodexThreadIndex({
    homeDir: join(codexHome, ".."),
    threadId: meta.id,
    rolloutPath: dest,
    cwd: meta.cwd,
  });
  console.log(`  indexed: ${JSON.stringify(result)}`);
  copied++;
}
console.log(`${found.length} rollouts found, ${copied} synced, ${skipped} skipped${apply ? "" : " (dry run)"}`);
