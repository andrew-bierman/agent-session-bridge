import type { NormalizedMessage } from "../../../packages/core/src/index.js";

/**
 * The conversation the scripted Codex and Claude runs have, as normalized
 * messages, so exporter tests can build the same session without a real run.
 * Tool ids differ from the mock's scripted ids on purpose: the mock only
 * matches the ids it scripted, so replayed history never re-triggers a fixture.
 */
export const PROMPT = "Run echo hello-from-codex and tell me what it printed.";
export const FINAL = "The command printed hello-from-codex.";
export const TOOL_OUTPUT = "hello-from-codex\n";

export function echoConversation(options: {
  callId: string;
  start?: string;
  prompt?: string;
}): NormalizedMessage[] {
  const start = Date.parse(options.start ?? "2026-11-24T01:00:00.000Z");
  const at = (seconds: number) =>
    new Date(start + seconds * 1000).toISOString();
  return [
    {
      id: "msg-user-1",
      role: "user",
      timestamp: at(0),
      content: [{ type: "text", text: options.prompt ?? PROMPT }],
    },
    {
      id: "msg-call-1",
      role: "assistant",
      timestamp: at(1),
      content: [
        {
          type: "tool_call",
          id: options.callId,
          name: "exec_command",
          arguments: { cmd: "echo hello-from-codex" },
        },
      ],
    },
    {
      id: "msg-result-1",
      role: "tool",
      timestamp: at(2),
      content: [
        {
          type: "tool_result",
          toolCallId: options.callId,
          toolName: "exec_command",
          output: TOOL_OUTPUT,
        },
      ],
    },
    {
      id: "msg-final-1",
      role: "assistant",
      timestamp: at(3),
      content: [{ type: "text", text: FINAL }],
    },
  ];
}
