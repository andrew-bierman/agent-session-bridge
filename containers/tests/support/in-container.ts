import { describe } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

// The container orchestrator (scripts/containers/run.ts) sets this inside the
// image. Host `bun test` therefore discovers these files, loads their imports,
// and skips every test in them, so the default suite stays fast and needs no
// container runtime.
export const inContainer = process.env.AGENT_BRIDGE_IN_CONTAINER === "1";

export const describeInContainer: typeof describe = inContainer
  ? describe
  : (describe.skip as typeof describe);

/** Where the image build records why an optional tool was not installed. */
const skipDir = process.env.ASB_SKIP_DIR ?? "/opt/asb/skips";

/** Reason an optional tool is unavailable in this image, or null when it is. */
export function skipReason(tool: "opencode" | "pi"): string | null {
  const file = join(skipDir, `${tool}.txt`);
  return existsSync(file) ? readFileSync(file, "utf8").trim() : null;
}

/**
 * Like `describeInContainer` for an optional tool: when the image build
 * recorded why the tool was not installed, the suite is skipped instead of
 * failing on a missing binary.
 */
export function describeToolInContainer(
  tool: "opencode" | "pi",
  name: string,
  fn: () => void,
): void {
  if (inContainer && skipReason(tool) === null) describe(name, fn);
  else describe.skip(name, fn);
}

/**
 * Copy a scenario's artifacts (rollouts, sessions, chat.db) into the mounted
 * output directory so a failing run can be inspected on the host. A no-op
 * outside the container or when no output directory is mounted.
 */
export function saveArtifacts(name: string, from: string): void {
  const out = process.env.ASB_OUT ?? "/out";
  if (!inContainer || !existsSync(out)) return;
  const { cpSync, mkdirSync } = require("node:fs") as typeof import("node:fs");
  mkdirSync(join(out, "artifacts"), { recursive: true });
  cpSync(from, join(out, "artifacts", name), { recursive: true });
}
