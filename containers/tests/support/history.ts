/**
 * The conversation history a journaled request carried. aimock journals every
 * wire it serves (Responses over HTTP or WebSocket, Anthropic Messages) in its
 * normalized chat form, so one reader works for Codex and Claude Code.
 */
export interface HistoryMessage {
  role: string;
  content?: unknown;
  tool_call_id?: string;
  tool_calls?: { id: string; function?: { name?: string } }[];
}

export function historyOf(body: unknown): HistoryMessage[] {
  const messages = (body as { messages?: unknown } | null)?.messages;
  return Array.isArray(messages) ? (messages as HistoryMessage[]) : [];
}

export const textOf = (message: HistoryMessage): string =>
  JSON.stringify(message.content ?? "");

export interface ExpectedHistory {
  prompt: string;
  callId: string;
  toolName: string;
  toolOutput: string;
  final: string;
  followUp: string;
}

/**
 * Index of each expected message in the history, or -1 when absent, in the
 * order they should appear: prompt, tool call, tool output, answer, follow-up.
 */
export function locateHistory(
  history: HistoryMessage[],
  expected: ExpectedHistory,
): number[] {
  const user = history.findIndex(
    (m) => m.role === "user" && textOf(m).includes(expected.prompt),
  );
  const call = history.findIndex((m) =>
    m.tool_calls?.some(
      (c) => c.id === expected.callId && c.function?.name === expected.toolName,
    ),
  );
  const output = history.findIndex(
    (m) =>
      m.role === "tool" &&
      m.tool_call_id === expected.callId &&
      textOf(m).includes(expected.toolOutput),
  );
  const final = history.findIndex(
    (m) => m.role === "assistant" && textOf(m).includes(expected.final),
  );
  const followUp = history.findIndex(
    (m) => m.role === "user" && textOf(m).includes(expected.followUp),
  );
  return [user, call, output, final, followUp];
}
