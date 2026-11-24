# Testing Guide

## Workflow

Use red-green-refactor for every task:

1. Add or extend a failing test.
2. Run the smallest relevant test target and confirm the failure is expected.
3. Implement the minimum change required to pass.
4. Run the broader suite.
5. Refactor only while the suite stays green.

## Commands

```bash
bun test
bun test:real-agents
bun test:watch
bun check .
bun run fixture:validate
bun lint
bun fmt --check
```

`bun run test:containers` is the hermetic counterpart: real Omnigent, Codex,
Claude Code and Pi in an offline container with only the model responses
scripted, so it needs no API keys and cannot touch your real tool homes. It
needs podman or docker and is opt-in; plain `bun test` skips it. See
[containers/README.md](containers/README.md).

`bun test:real-agents` runs the heavyweight command-level E2E matrix. It creates real Pi, Claude Code, and Codex sessions, imports them through native bridge conversions, resumes the imported sessions with the real CLIs, and verifies:

- round-trip continuation across all six ordered tool pairs
- multi-hop three-agent sequences such as `pi -> claude -> codex -> pi -> codex -> claude`

This suite expects those CLIs to be installed and authenticated on the machine running it.

## Regression Policy

- Keep sanitized fixtures under `packages/core/test/fixtures`.
- Add a regression test for every bug fixed in parsing, conversion, or dedupe behavior.
- Do not mark checklist items done unless tests cover the behavior.
