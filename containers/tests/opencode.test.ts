import { expect, it } from "bun:test";

import { versions } from "../versions.js";
import { describeInContainer } from "./support/in-container.js";

// OpenCode is not round-tripped here: the bridge's OpenCode reader consumes the
// OpenCode v2 session export, while this image pins OpenCode 1.x because
// Omnigent supports only OpenCode below 2.1.0. The guard below fails the day the
// pin moves to 2.x, so the skip cannot go stale: that change must add the real
// round trip (create a session against the mock, `opencode export`, load it with
// the bridge, export to Codex and Claude, resume).
describeInContainer("OpenCode round trip", () => {
  it("is skipped only while the image pins OpenCode 1.x, which the bridge cannot read", () => {
    expect(versions.opencode).toMatch(/^1\./);
  });

  it.todo(
    "round-trips a real OpenCode session through the bridge (skipped: image pins OpenCode 1.x, bridge reads the v2 export)",
    () => {},
  );
});
