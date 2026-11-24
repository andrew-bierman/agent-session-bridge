#!/usr/bin/env bun
// Build the hermetic integration image. Versions come from containers/versions.ts
// so each pinned binary has one owner. Works with rootless podman or docker.
//
// Usage: bun scripts/containers/build.ts [--tag <image>] [--dry-run]
import { join } from "node:path";
import { buildArgs } from "../../containers/versions.js";
import { selectRuntime } from "./runtime.js";

export const defaultTag = "localhost/agent-session-bridge-containers:dev";

export function buildArgv(
  runtime: string,
  tag: string,
  root: string,
): string[] {
  const args = Object.entries(buildArgs()).flatMap(([key, value]) => [
    "--build-arg",
    `${key}=${value}`,
  ]);
  return [
    runtime,
    "build",
    "-f",
    join(root, "containers", "Containerfile"),
    "-t",
    tag,
    ...args,
    root,
  ];
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const tagIndex = argv.indexOf("--tag");
  const tag = tagIndex >= 0 ? (argv[tagIndex + 1] ?? defaultTag) : defaultTag;
  const root = join(import.meta.dirname, "..", "..");
  const runtime = selectRuntime();
  const command = buildArgv(runtime, tag, root);
  if (argv.includes("--dry-run")) {
    console.log(command.join(" "));
    process.exit(0);
  }
  const child = Bun.spawn(command, {
    stdout: "inherit",
    stderr: "inherit",
    env: process.env,
  });
  process.exit(await child.exited);
}
