import { describe, expect, it } from "bun:test";
import { join } from "node:path";

import { buildArgs } from "../../containers/versions.js";
import { buildArgv, defaultTag } from "./build.js";
import { buildRunArgv, newRunId, outDirFor, parseRunArgs } from "./run.js";
import { selectRuntime } from "./runtime.js";

const found = (names: string[]) => (cmd: string) =>
  names.includes(cmd) ? `/usr/bin/${cmd}` : null;

describe("selectRuntime", () => {
  it("prefers podman when both runtimes exist", () => {
    expect(selectRuntime({ env: {}, which: found(["podman", "docker"]) })).toBe(
      "podman",
    );
  });

  it("falls back to docker when podman is missing", () => {
    expect(selectRuntime({ env: {}, which: found(["docker"]) })).toBe("docker");
  });

  it("lets CONTAINER_RUNTIME override the default order", () => {
    expect(
      selectRuntime({
        env: { CONTAINER_RUNTIME: "docker" },
        which: found(["podman", "docker"]),
      }),
    ).toBe("docker");
  });

  it("rejects an unsupported CONTAINER_RUNTIME value", () => {
    expect(() =>
      selectRuntime({
        env: { CONTAINER_RUNTIME: "nerdctl" },
        which: found(["podman"]),
      }),
    ).toThrow("CONTAINER_RUNTIME must be podman or docker");
  });

  it("rejects a requested runtime that is not installed", () => {
    expect(() =>
      selectRuntime({
        env: { CONTAINER_RUNTIME: "docker" },
        which: found(["podman"]),
      }),
    ).toThrow("docker was requested but is not installed");
  });

  it("names both supported runtimes when none is installed", () => {
    expect(() => selectRuntime({ env: {}, which: found([]) })).toThrow(
      /podman or docker/,
    );
  });
});

describe("buildRunArgv", () => {
  const base = {
    image: "localhost/agent-session-bridge-containers:dev",
    outDir: "/home/me/.cache/agent-session-bridge/containers/run-1/out",
    uid: 1000,
    gid: 1000,
  };

  it("runs offline, removes the container, and mounts exactly one directory", () => {
    const argv = buildRunArgv({ runtime: "podman", ...base });
    expect(argv).toContain("--network=none");
    expect(argv).toContain("--rm");
    expect(argv.filter((a) => a === "-v")).toHaveLength(1);
    expect(argv).toContain(`${base.outDir}:/out`);
  });

  it("marks the run as in-container and sets a throwaway home", () => {
    const argv = buildRunArgv({ runtime: "podman", ...base });
    expect(argv).toContain("AGENT_BRIDGE_IN_CONTAINER=1");
    expect(argv).toContain("HOME=/home/asb");
    expect(argv).toContain("TMPDIR=/home/asb/tmp");
  });

  it("passes no host home path, no credential variables, and no host env", () => {
    const argv = buildRunArgv({ runtime: "podman", ...base });
    const text = argv.join(" ");
    expect(text).not.toMatch(/API_KEY|TOKEN|SECRET|OPENAI|ANTHROPIC/);
    expect(argv.filter((a) => a === "-e").length).toBe(
      argv.filter((a) => /^[A-Z_]+=/.test(a)).length,
    );
    expect(argv.some((a) => a.includes("/.codex"))).toBe(false);
    expect(argv.some((a) => a.includes("/.claude"))).toBe(false);
    expect(argv.some((a) => a.includes("/.omnigent"))).toBe(false);
  });

  it("maps the host user for rootless podman and for docker", () => {
    expect(buildRunArgv({ runtime: "podman", ...base })).toContain(
      "--userns=keep-id",
    );
    const docker = buildRunArgv({ runtime: "docker", ...base });
    expect(docker).toContain("--user");
    expect(docker).toContain("1000:1000");
    expect(docker).not.toContain("--userns=keep-id");
  });

  it("forwards extra test arguments after the image", () => {
    const argv = buildRunArgv({
      runtime: "podman",
      ...base,
      testArgs: ["bun", "test", "containers/tests/mock.test.ts"],
    });
    expect(argv.slice(-3)).toEqual([
      "bun",
      "test",
      "containers/tests/mock.test.ts",
    ]);
    expect(argv.indexOf(base.image)).toBeLessThan(argv.indexOf("bun"));
  });
});

describe("run locations", () => {
  it("keeps output under the SSD cache, never /tmp", () => {
    const dir = outDirFor("/home/me", "run-9");
    expect(dir).toBe(
      "/home/me/.cache/agent-session-bridge/containers/run-9/out",
    );
    expect(dir.startsWith("/tmp")).toBe(false);
  });

  it("makes unique run ids", () => {
    expect(newRunId()).not.toBe(newRunId());
  });
});

describe("buildArgv", () => {
  it("passes every pinned version as a build arg and targets the Containerfile", () => {
    const argv = buildArgv("podman", defaultTag, "/repo");
    expect(argv.slice(0, 2)).toEqual(["podman", "build"]);
    expect(argv).toContain("/repo/containers/Containerfile");
    expect(argv).toContain("OMNIGENT_VERSION=0.23.0");
    expect(argv).toContain("CODEX_VERSION=0.172.0");
    expect(argv).toContain("CLAUDE_CODE_VERSION=2.1.331");
    expect(argv.at(-1)).toBe("/repo");
  });
});

describe("parseRunArgs", () => {
  it("uses the default tag, builds, and runs the default command with no arguments", () => {
    expect(parseRunArgs([])).toEqual({ tag: defaultTag, noBuild: false });
  });

  it("treats the first non-flag argument as the start of the test command", () => {
    expect(
      parseRunArgs([
        "--no-build",
        "bun",
        "test",
        "containers/tests/x.test.ts",
        "-t",
        "name",
      ]),
    ).toEqual({
      tag: defaultTag,
      noBuild: true,
      testArgs: ["bun", "test", "containers/tests/x.test.ts", "-t", "name"],
    });
  });

  it("accepts --tag and an explicit -- separator", () => {
    expect(parseRunArgs(["--tag", "img:1", "--", "bun", "test"])).toEqual({
      tag: "img:1",
      noBuild: false,
      testArgs: ["bun", "test"],
    });
  });
});

describe("build --print-build-args", () => {
  it("prints every pinned version as KEY=VALUE, the same set the build passes", () => {
    const out = Bun.spawnSync(
      ["bun", join(import.meta.dir, "build.ts"), "--print-build-args"],
      { stdout: "pipe" },
    )
      .stdout.toString()
      .trim()
      .split("\n");
    expect(out).toEqual(
      Object.entries(buildArgs()).map(([key, value]) => `${key}=${value}`),
    );
  });
});
