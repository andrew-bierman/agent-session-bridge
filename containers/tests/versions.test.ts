import { expect, it } from "bun:test";

import { versions } from "../versions.js";
import { describeInContainer, skipReason } from "./support/in-container.js";

function run(command: string, args: string[]) {
  const result = Bun.spawnSync([command, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  return `${result.stdout.toString()}${result.stderr.toString()}`;
}

describeInContainer("pinned harness versions", () => {
  it("has the pinned Omnigent installed", () => {
    expect(run("omni", ["--version"])).toContain(versions.omnigent);
  });

  it("has the pinned Codex installed", () => {
    expect(run("codex", ["--version"])).toContain(versions.codex);
  });

  it("has the pinned Claude Code installed", () => {
    expect(run("claude", ["--version"])).toContain(versions.claudeCode);
  });

  for (const tool of ["opencode", "pi"] as const) {
    const reason = skipReason(tool);
    (reason ? it.skip : it)(
      `has the pinned ${tool} installed${reason ? ` (skipped: ${reason})` : ""}`,
      () => {
        expect(run(tool, ["--version"])).toContain(versions[tool]);
      },
    );
  }

  it("has sqlite3 and tmux for the scenarios", () => {
    expect(run("sqlite3", ["--version"])).toMatch(/^3\./);
    expect(run("tmux", ["-V"])).toMatch(/^tmux /);
  });

  it("runs with a throwaway HOME and no host credentials", () => {
    expect(process.env.HOME).toBe("/home/asb");
    for (const key of Object.keys(process.env)) {
      expect(key).not.toMatch(/API_KEY|TOKEN|SECRET/);
    }
  });
});
