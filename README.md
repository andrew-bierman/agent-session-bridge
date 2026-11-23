# Agent Session Bridge

[![CI](https://github.com/bohdanpodvirnyi/agent-session-bridge/actions/workflows/ci.yml/badge.svg)](https://github.com/bohdanpodvirnyi/agent-session-bridge/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)
[![npm version](https://img.shields.io/npm/v/agent-session-bridge.svg)](https://www.npmjs.com/package/agent-session-bridge)

Local-first session portability for Pi, Claude Code, and Codex.

`agent-session-bridge` mirrors resumable conversations between the three local coding agents so you can start in one tool, switch tools in the same folder, and keep going from the same thread.

![Agent Session Bridge demo](./docs/images/demo-three-agents-v2.png)

https://github.com/user-attachments/assets/d1b151a4-78e9-42ef-98ee-bb5045809f51

## Why

Each agent stores sessions in a different place and in a different format:

- Pi uses session trees in `~/.pi/agent/sessions`
- Claude Code uses JSONL transcripts in `~/.claude/projects`
- Codex uses rollout event logs in `~/.codex/sessions`

This project sits between them and keeps those local stores in sync.

The goal is simple:

1. talk to Pi in a repo
2. open Claude Code or Codex in that same repo
3. resume the same conversation instead of starting over

## What Makes It Different

This repo is not a session viewer, a skills sync, or a live agent-to-agent bridge.

It is focused on one job:

- parse native session formats
- convert them into the other tools' native formats
- keep replay-safe mirror state on disk
- repair older imported sessions when history got messy

The distinctive angle is `local-first durability`.

- The bridge writes directly into each tool's own session store.
- The CLI installs self-contained runtime assets into `~/.agent-session-bridge/runtime`.
- Sync, repair, and validation are all built around real local agent behavior.

## Install

Public npm install:

```bash
npx agent-session-bridge setup
npx agent-session-bridge doctor
```

Or install globally:

```bash
npm install -g agent-session-bridge
agent-session-bridge setup
agent-session-bridge doctor
```

Tarball flow also works if you want to test an unpublished local build:

```bash
npm pack
npx --yes --package ./agent-session-bridge-0.1.2.tgz agent-session-bridge setup
npx --yes --package ./agent-session-bridge-0.1.2.tgz agent-session-bridge doctor
```

Local checkout flow:

```bash
git clone https://github.com/bohdanpodvirnyi/agent-session-bridge.git
cd agent-session-bridge

pnpm install
pnpm build
node packages/cli/dist/cli/src/index.js setup
node packages/cli/dist/cli/src/index.js doctor
```

## CLI

Main commands:

- `setup`: install Pi, Claude Code, and Codex integration for the current repo
- `enable`: enable sync for the current repo or globally
- `doctor`: read-only health check for bridge config, installed integrations, hook status, and registry links for the current repo
- `repair`: rewrite already-existing mirrored Pi or Claude session files for the current repo when imported history needs cleanup
- `import`: backfill foreign sessions into selected target tools with `--latest` or `--all`
- `list`: show registry conversations
- `audit`: dump the local bridge registry

Examples:

```bash
agent-session-bridge setup
agent-session-bridge enable --global
agent-session-bridge doctor
agent-session-bridge repair
agent-session-bridge import --tool codex --all
```

### Command Semantics

- `doctor` does not import, repair, or create links.
- `doctor` reports bridge registry conversations linked to the current repo, not the total number of raw session files on disk.
- `repair` only cleans mirrored Pi and Claude session files that already exist for the current repo.
- `repair` does not backfill old sessions, discover missing sessions, or create new bridge links.
- `import --latest` imports the single best foreign-session candidate for the repo into the selected target tool.
- `import --all` is the one-shot backfill command. It imports original foreign-session candidates for the repo into the selected target tool. Bridge-created mirrors are excluded from bulk source discovery; ongoing sync picks up turns added to those mirrors.
- Add `--dry-run` to preview the latest candidate or count bulk candidate routes without writing to any session store or the registry.

Typical recovery flow:

1. Run `agent-session-bridge doctor` to confirm setup, config, and hook health.
2. Run `agent-session-bridge import --tool <target> --all` to backfill older sessions into a target tool.
3. Run `agent-session-bridge repair` only if imported Pi or Claude transcripts need cleanup afterward.

## How It Works

At a high level:

1. detect a source session from Pi, Claude Code, or Codex
2. normalize it into a shared internal message model
3. write compatible mirror entries into the target tool stores
4. track offsets and mirror identities in a local registry
5. prevent replay loops and repair malformed historical imports

Runtime state lives under:

- `~/.agent-session-bridge/config.json`
- `~/.agent-session-bridge/registry.json`
- `~/.agent-session-bridge/runtime/`

## Repo Layout

Top-level packages:

- `packages/core`: parsers, converters, registry, config, sync, dedupe, repair helpers
- `packages/cli`: install, doctor, import, repair, audit, and setup commands
- `packages/pi`: Pi integration surface
- `packages/claude-code`: Claude Code integration surface
- `packages/codex`: Codex integration surface
- `packages/daemon`: optional backfill and filesystem-driven helpers

Reference material:

- [examples/config/global.json](./examples/config/global.json)
- [examples/config/project-allowlist.json](./examples/config/project-allowlist.json)
- [examples/flows/three-agent-loop.md](./examples/flows/three-agent-loop.md)
- [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md)
- [docs/HOOKS.md](./docs/HOOKS.md)
- [docs/TROUBLESHOOTING.md](./docs/TROUBLESHOOTING.md)
- [TESTING.md](./TESTING.md)
- [CONTRIBUTING.md](./CONTRIBUTING.md)

## Validation

This repo includes:

- parser and converter unit tests
- file-level end-to-end coverage
- temp-home integration tests
- real-command E2E coverage against installed `pi`, `claude`, and `codex`

Run the standard suite:

```bash
pnpm test
pnpm typecheck
pnpm fixture:validate
pnpm exec prettier --check .
```

Run the real-agent suite:

```bash
pnpm test:real-agents
```

## Examples

Config examples live in [examples/config](./examples/config).

The demo loop in [examples/flows/three-agent-loop.md](./examples/flows/three-agent-loop.md) shows the intended flow:

1. start a conversation in Pi
2. resume it in Claude Code
3. continue it in Codex
4. come back to Pi and keep going

## Current Limitations

- Older imported transcripts can still need `repair` if they were created by earlier bridge versions.
- Some legacy Codex imports can still emit orphan-output warnings during resume.
- Public API and config shape may still evolve as the project hardens.

### Import an OpenCode session

Export a session with OpenCode v2, then import it into a Bridge-managed mirror:

```sh
opencode session export --standalone SESSION_ID > session.json
agent-session-bridge import-opencode session.json --tool codex
```

Pass multiple JSON files to import a batch. Add `--dry-run` to check
transcript content and project directories without writing session files.
Files are processed in argument order. The command reports a rejection by
argument number, continues through the batch, and returns a nonzero status if
any file was rejected. A preview does not check destination conflicts.

Use a fresh export of the same session to pick up new text messages. Identical
exports do not duplicate messages. Settled tool calls with text results are
carried as historical text, so the receiving client can read them without
replaying them as tool calls. Synthetic records and completed compaction
summaries are carried as labeled historical text, along with finished shell
records and project-location changes. Failed assistant turns retain partial
text and receive a marker. Detected user attachments receive a marker while
the attachment stays in OpenCode. OpenCode system records are omitted and
counted in the report. Provider reasoning is omitted. Shortened or edited
exports and unsettled calls are rejected. This command
imports from OpenCode without writing to its store. For a session whose
original project is gone, pass `--target-cwd /path/to/existing/project` to
place its native mirror in that directory. Future imports reuse that location.

To rehearse the return path on a disposable OpenCode 2.3.0 or 2.3.2
database, finish a text turn in the linked Codex mirror and stop both
clients before running:

```sh
agent-session-bridge return-to-opencode CODEX_SESSION_ID /path/to/copied/opencode.db
```

Bridge appends to the linked OpenCode session ID, skips identical retries,
and refuses divergent histories. To switch back to Codex, export the OpenCode
session again and repeat the import into the linked Codex mirror. Bridge
skips the returned turns already in Codex. This is a manual text-only handoff.

For a linked or new OpenCode text session, the same command can handle both
directions on a disposable or backed-up store. Stop both clients before sync:

```sh
agent-session-bridge sync-opencode OPENCODE_SESSION_ID /path/to/opencode.db
```

To make one pass over the active linked sessions, run:

```sh
agent-session-bridge sync-opencode --all /path/to/opencode.db
```

A conflict is reported per session. The pass continues with the other
links and exits with status 1 if any link is rejected.

The command creates or updates the Codex mirror when OpenCode is ahead, or
returns pending Codex text turns when OpenCode is unchanged. If both sides
have new turns, it refuses the sync and leaves both histories intact.

Bridge rejects overlapping imports and OpenCode returns against the same
registry. If a process is killed, it can leave an empty
`registry.json.write-lock` directory beside the registry. Check that no
Bridge writer is running and inspect the registry and affected mirrors
before clearing a stale lock. An interrupted import can leave partially
written mirrors even though the registry was never updated.

To create a native OpenCode session from a Codex, Claude Code, or
Pi transcript, run this from the intended project directory against a
disposable OpenCode 2.3.0 or 2.3.2 database:

```sh
agent-session-bridge seed-opencode codex /path/to/rollout.jsonl /path/to/opencode.db
```

Preview a batch of transcripts without opening an OpenCode database or
writing to the registry:

```sh
agent-session-bridge seed-opencode codex /path/to/rollout-*.jsonl --dry-run
```

The preview lists eligible sessions and rejection reasons and exits with
status 1 if any candidate is rejected.

Apply a batch against a disposable database copy using the project directory
recorded in each transcript:

```sh
agent-session-bridge seed-opencode codex /path/to/rollout-*.jsonl --database /path/to/copy.db
```

Each candidate is verified independently. Use `--target-cwd DIRECTORY` to
provide a fallback for transcripts whose original project no longer exists.
The batch continues after a rejected candidate and returns status 1 if any
candidate is rejected.

Use `claude` or `pi` for those transcript formats. The command verifies the
import by exporting the native session. An identical retry reuses the same
ID. Changed source history is rejected if the mirror already exists. Seeding
links the original Codex, Claude Code, or Pi transcript by its native ID.
It preserves settled tool calls and results as historical text. Append
`--allow-incomplete-tools` to preview or import older transcripts that contain
unmatched or ambiguous calls or results. In those imports, tool records are
labeled as unverified historical text. Ongoing sync still waits for a complete
pair in newly appended tool history. Detected image attachments, reasoning,
and empty messages are marked in the imported transcript. Image payloads
and reasoning text stay in the original transcript.
Run `sync-opencode` with the ID printed by the seed command to exchange new
text turns and settled tool history with that transcript. A changed seed prefix or independent turns
on both sides stop sync.

Compressed Codex rollouts can seed OpenCode. The bridge refuses to append
new turns directly to the compressed file.
