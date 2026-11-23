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

bun install
bun run build
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
- `import --all` is the one-shot backfill command. It imports all foreign-session candidates for the repo into the selected target tool.

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
bun test
bun check .
bun run fixture:validate
bun fmt --check
```

Run the real-agent suite:

```bash
bun test:real-agents
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

Use a fresh export of the same session to pick up new text messages. Identical
exports do not duplicate messages. Settled tool calls with text results are
carried as historical text, so the receiving client can read them without
replaying them as tool calls. Provider reasoning is omitted. Shortened or
edited exports, attachments, and unsettled calls are rejected. This command
imports from OpenCode without writing to its store.

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

The command creates or updates the Codex mirror when OpenCode is ahead, or
returns pending Codex text turns when OpenCode is unchanged. If both sides
have new turns, it refuses the sync and leaves both histories intact.
