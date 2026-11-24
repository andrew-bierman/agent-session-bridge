// Pinned harness releases for the container integration tier. The Containerfile
// build reads this file (scripts/containers/build.ts passes each value as a
// build arg), so each binary's version has exactly one owner. aimock is the
// exception: its single owner is package.json, so host `bun test` and the image
// resolve the same package from bun.lock.
//
// Pi and OpenCode are optional layers: a failed install records a skip reason
// instead of failing the build.
export const versions = {
  /** PyPI package `omnigent`. Needs Python >= 3.12. */
  omnigent: "0.23.0",
  /** openai/codex GitHub release, tag `rust-v<version>`. */
  codex: "0.172.0",
  /** Native Claude Code distribution (downloads.claude.ai/claude-code-releases). */
  claudeCode: "2.1.331",
  /**
   * anomalyco/opencode v1 release (without the "v"). Omnigent supports OpenCode
   * below 2.1.0 only, so the image keeps 1.x for it.
   */
  opencode: "1.19.6",
  /**
   * anomalyco/opencode v2 release. The bridge reads and seeds OpenCode's 2.3
   * database only, so this second install is what the OpenCode tests run;
   * the 1.x binary above exists for Omnigent.
   */
  opencodeV2: "2.3.2",
  /** earendil-works/pi GitHub release (without the "v"). */
  pi: "1.6.0",
  /** Python toolchain version uv installs for Omnigent. */
  python: "3.14",
} as const;

export type ToolName = keyof typeof versions;

/** Tools whose install failure must not fail the image build. */
export const optionalTools = ["opencode", "opencodeV2", "pi"] as const;

/** Build args in the order the Containerfile declares them. */
export function buildArgs(): Record<string, string> {
  return {
    OMNIGENT_VERSION: versions.omnigent,
    CODEX_VERSION: versions.codex,
    CLAUDE_CODE_VERSION: versions.claudeCode,
    OPENCODE_VERSION: versions.opencode,
    OPENCODE_V2_VERSION: versions.opencodeV2,
    PI_VERSION: versions.pi,
    PYTHON_VERSION: versions.python,
  };
}
