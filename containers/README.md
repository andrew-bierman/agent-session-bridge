# Container integration tier

Real Omnigent, Codex, Claude Code, OpenCode and Pi run inside one offline container with
only the model responses scripted. The tests prove what the bridge exports: that
native Codex and Claude Code sessions exported from Omnigent (including
spec-defined sub-agents that exist only in its `chat.db`) load, resume, and
replay their history; that Omnigent's own native Codex bridge syncs and resumes;
that a real Pi session round-trips into Codex and Claude Code; and that a real OpenCode session exports into both, while a Codex session seeded into OpenCode resumes there with its history.

```bash
bun run containers:build   # build the image (needs podman or docker)
bun run test:containers    # build, then run containers/tests inside it
bun scripts/containers/run.ts --no-build bun test containers/tests/codex.test.ts
```

`CONTAINER_RUNTIME=podman|docker` overrides the default (podman, then docker).
Output (JUnit and the artifacts of each scenario) lands in
`~/.cache/agent-session-bridge/containers/<run>/out/`.

## How it stays hermetic

- Run with `--network=none`, a throwaway `HOME`, and one bind mount: the output
  directory. No host home, credential, or environment variable enters the
  container, and nothing here controls host processes.
- The mock is [aimock](https://github.com/CopilotKit/aimock), pinned in
  `package.json`, serving OpenAI Responses (HTTP and WebSocket) and Anthropic
  Messages. Its request journal proves each tool reached it; a request no
  fixture answers returns 404 and fails the test.
- Pinned tool versions live in `versions.ts` and are passed to the build; bump
  them deliberately and re-run. Omnigent, Codex and Claude Code are required;
  OpenCode and Pi are optional layers that skip their own tests if they fail to
  install.

## What real binaries taught us

- Codex's interactive `codex resume` is the path that proves a session loads.
  `codex exec resume` cannot load a thread whose turns ran a command
  ("list_turns is not supported yet"), so tests resume through a terminal.
- Codex needs its complete package, `ps`, an `auth.json`, and a trusted project
  to start the interactive client like a logged-in user's.
- Omnigent bridges Codex through its own `omnigent_provider`; the sync script
  retargets that provider (default `openai`) so plain Codex can resume the copy.
- OpenCode needs two installs. The bridge reads and seeds the OpenCode 2.3
  database, but Omnigent supports OpenCode below 2.1 only, so the image carries
  1.x (`opencode`, for Omnigent) and 2.3.2 (`opencode2`, for the OpenCode
  tests). The bridge CLI runs `opencode` from `PATH`, so the seed test puts the
  2.x binary first. The built-in `openai` provider takes a `baseURL`, which is
  how it reaches the mock; `session export --standalone` is the export command.
- A settled OpenCode tool call reaches Codex and Claude Code as a labeled text
  record (call id, command, real output), not a replayable tool call. Real
  OpenCode names its command tool `shell`.
