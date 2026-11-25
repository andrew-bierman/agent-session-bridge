// Pick the container runtime. Rootless podman is preferred locally; docker is
// what CI runners have. CONTAINER_RUNTIME=podman|docker overrides the order.
export type Runtime = "podman" | "docker";

export interface RuntimeOptions {
  env?: Record<string, string | undefined>;
  which?: (command: string) => string | null;
}

export function selectRuntime(options: RuntimeOptions = {}): Runtime {
  const env = options.env ?? process.env;
  const which = options.which ?? ((command: string) => Bun.which(command));
  const requested = env.CONTAINER_RUNTIME;

  if (requested) {
    if (requested !== "podman" && requested !== "docker") {
      throw new Error(
        `CONTAINER_RUNTIME must be podman or docker, got "${requested}"`,
      );
    }
    if (!which(requested)) {
      throw new Error(`${requested} was requested but is not installed`);
    }
    return requested;
  }

  for (const candidate of ["podman", "docker"] as const) {
    if (which(candidate)) return candidate;
  }
  throw new Error(
    "No container runtime found. Install rootless podman or docker (podman or docker; set CONTAINER_RUNTIME to choose).",
  );
}
