#!/usr/bin/env bun
// Run the container integration tests inside the hermetic image.
//
// Usage: bun scripts/containers/run.ts [--tag <image>] [--no-build] [-- <test command>]
//
// The container runs with no network, a throwaway HOME, and one bind mount: a
// per-run output directory under ~/.cache/agent-session-bridge/containers/. No
// host home directory, credential, or environment variable enters it, and
// nothing here controls host processes. Exit code is the container's.
import { randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { buildArgv, defaultTag } from "./build.js";
import { selectRuntime, type Runtime } from "./runtime.js";

export interface RunOptions {
  runtime: Runtime;
  image: string;
  outDir: string;
  uid: number;
  gid: number;
  /** Command run in the image; defaults to the image's own CMD. */
  testArgs?: string[];
}

export function newRunId(): string {
  return `${Date.now().toString(36)}-${randomBytes(4).toString("hex")}`;
}

export function outDirFor(home: string, runId: string): string {
  return join(home, ".cache", "agent-session-bridge", "containers", runId, "out");
}

export function buildRunArgv(options: RunOptions): string[] {
  const userFlags =
    options.runtime === "podman"
      ? ["--userns=keep-id"]
      : ["--user", `${options.uid}:${options.gid}`];
  const env = {
    AGENT_BRIDGE_IN_CONTAINER: "1",
    HOME: "/home/asb",
    TMPDIR: "/home/asb/tmp",
    CI: "1",
  };
  return [
    options.runtime,
    "run",
    "--rm",
    "--network=none",
    "--security-opt=no-new-privileges",
    ...userFlags,
    ...Object.entries(env).flatMap(([key, value]) => ["-e", `${key}=${value}`]),
    "-v",
    `${options.outDir}:/out`,
    options.image,
    ...(options.testArgs ?? []),
  ];
}

async function spawn(argv: string[]): Promise<number> {
  const child = Bun.spawn(argv, {
    stdout: "inherit",
    stderr: "inherit",
    env: process.env,
  });
  return child.exited;
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const split = argv.indexOf("--");
  const own = split >= 0 ? argv.slice(0, split) : argv;
  const testArgs = split >= 0 ? argv.slice(split + 1) : undefined;
  const tagIndex = own.indexOf("--tag");
  const tag = tagIndex >= 0 ? (own[tagIndex + 1] ?? defaultTag) : defaultTag;
  const runtime = selectRuntime();
  const root = join(import.meta.dirname, "..", "..");

  if (!own.includes("--no-build")) {
    const built = await spawn(buildArgv(runtime, tag, root));
    if (built !== 0) process.exit(built);
  }

  const outDir = outDirFor(homedir(), newRunId());
  mkdirSync(outDir, { recursive: true });
  console.log(`container output: ${outDir}`);
  const code = await spawn(
    buildRunArgv({
      runtime,
      image: tag,
      outDir,
      uid: process.getuid?.() ?? 1000,
      gid: process.getgid?.() ?? 1000,
      testArgs: testArgs ?? [
        "bun",
        "test",
        "containers/tests",
        "--reporter=junit",
        "--reporter-outfile=/out/junit.xml",
      ],
    }),
  );
  process.exit(code);
}
