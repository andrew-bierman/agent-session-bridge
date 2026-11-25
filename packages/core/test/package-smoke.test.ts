import { describe, expect, it } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import rootPackage from "../../../package.json";
import corePackage from "../package.json";

const root = join(import.meta.dir, "..", "..", "..");

describe("package smoke", () => {
  it("exposes publishable package metadata", () => {
    expect(corePackage.name).toBe("agent-session-bridge-core");
    expect(rootPackage.bin["agent-session-bridge"]).toBe(
      "bin/agent-session-bridge",
    );
  });

  it("runs on Bun straight from TypeScript source, with no build step", () => {
    const bin = readFileSync(join(root, "bin", "agent-session-bridge"), "utf8");
    expect(bin.startsWith("#!/usr/bin/env bun\n")).toBe(true);
    expect(bin).toContain("../packages/cli/src/index.ts");
    expect(Object.keys(rootPackage.engines)).toEqual(["bun"]);
    expect(rootPackage.scripts).not.toHaveProperty("build");
    expect(JSON.stringify(rootPackage.files)).not.toContain("dist");
    for (const name of [
      "core",
      "cli",
      "claude-code",
      "codex",
      "daemon",
      "pi",
    ]) {
      const pkg = JSON.parse(
        readFileSync(join(root, "packages", name, "package.json"), "utf8"),
      ) as { main: string; scripts?: Record<string, string> };
      expect(pkg.main.endsWith(".ts")).toBe(true);
      expect(existsSync(join(root, "packages", name, pkg.main))).toBe(true);
      expect(pkg.scripts).not.toHaveProperty("build");
    }
  });
});
