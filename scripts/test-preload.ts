// Keep test temp dirs on disk. /tmp is RAM-backed (tmpfs) on our machines and
// has filled up before, so point os.tmpdir() at an SSD cache dir unless the
// caller already chose one outside /tmp.
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const current = process.env.TMPDIR;
if (!current || current === "/tmp" || current.startsWith("/tmp/")) {
  const dir = join(homedir(), ".cache", "agent-session-bridge", "tmp");
  mkdirSync(dir, { recursive: true });
  process.env.TMPDIR = dir;
}
