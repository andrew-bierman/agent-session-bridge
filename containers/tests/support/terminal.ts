import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

/**
 * A detached terminal (tmux) for tools that need a TTY. The command's terminal
 * stays open after it exits so its screen can still be read. Everything is
 * container-local: nothing on the host is touched.
 */
export class Terminal {
  constructor(
    private readonly env: Record<string, string>,
    private readonly cwd: string,
    private readonly name: string,
    tmuxDir: string,
  ) {
    mkdirSync(tmuxDir, { recursive: true });
    this.env = { ...env, TMUX_TMPDIR: tmuxDir };
  }

  static in(
    root: string,
    env: Record<string, string>,
    cwd: string,
    name: string,
  ): Terminal {
    return new Terminal(env, cwd, name, join(root, "tmux"));
  }

  private tmux(...args: string[]): string {
    try {
      return execFileSync("tmux", args, {
        env: this.env,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      return String((error as { stdout?: string }).stdout ?? "");
    }
  }

  /** Run a shell command line; the terminal stays open afterwards. */
  start(command: string): void {
    this.tmux(
      "new-session",
      "-d",
      "-s",
      this.name,
      "-x",
      "200",
      "-y",
      "50",
      "-c",
      this.cwd,
      `${command}; echo TERMINAL_EXITED; sleep 600`,
    );
  }

  screen(): string {
    return this.tmux("capture-pane", "-p", "-t", this.name, "-S", "-200");
  }

  keys(...keys: string[]): void {
    this.tmux("send-keys", "-t", this.name, ...keys);
  }

  kill(): void {
    this.tmux("kill-session", "-t", this.name);
  }
}

export const shellQuote = (value: string): string =>
  `'${value.replaceAll("'", `'\\''`)}'`;
