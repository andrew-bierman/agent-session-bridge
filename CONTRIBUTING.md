# Contributing

## Setup

```bash
bun install
bun run build
bun test
bun check .
```

## Workflow

Use the red-green-refactor loop described in [TESTING.md](./TESTING.md).

Before opening a PR:

```bash
bun run release:check
bun run fixture:validate
bun fmt --check
```

## Project Layout

- `packages/core`: canonical parsing, conversion, registry, sync, and safety logic
- `packages/cli`: local command surface
- `packages/pi`: Pi integration surface
- `packages/claude-code`: Claude Code integration surface
- `packages/codex`: Codex integration surface
- `packages/daemon`: optional backfill and repair helpers

## Scope Notes

- Keep new behavior covered by automated tests.
- Prefer adding sanitized fixtures instead of mock-heavy tests when format behavior matters.
- Do not mark live-runtime validation done unless it has been verified in the actual external tool.
