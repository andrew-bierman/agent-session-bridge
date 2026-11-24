import {
  LLMock,
  type FixtureFileEntry,
  type JournalEntry,
} from "@copilotkit/aimock";

import { historyOf, textOf, type HistoryMessage } from "./history.js";

/**
 * A scripted model for the container tier. Only model responses are faked; the
 * harnesses are real. One server speaks OpenAI Responses and Anthropic
 * Messages, and its journal records every request so tests can prove each
 * harness reached it (and see the history it was sent).
 */
export interface ToolRound {
  /** Tool call id the model emits; the follow-up request carries it back. */
  id: string;
  name: string;
  args: Record<string, unknown>;
}

export type Wire = "responses" | "messages" | "chat";

const wirePrefix: Record<Wire, string> = {
  responses: "/v1/responses",
  messages: "/v1/messages",
  chat: "/v1/chat/completions",
};

export class ScriptedMock {
  private constructor(readonly llm: LLMock) {}

  static async start(): Promise<ScriptedMock> {
    const llm = new LLMock({ port: 0 });
    // Codex opens a WebSocket at startup and sends a warm-up frame that carries
    // no user turn. Unanswered, it costs a 20 second timeout before Codex falls
    // back. Answer only requests with neither a user message nor a tool result:
    // every real prompt has a user message, and a WebSocket continuation carries
    // just the tool result, so both still reach their own fixtures and an
    // unscripted prompt still returns 404.
    llm.addFixture({
      match: {
        predicate: (req) =>
          !req.messages.some((m) => m.role === "user" || m.role === "tool"),
      },
      response: { content: "ready" },
    });
    // The interactive Codex client asks for a task title on every new turn.
    llm.addFixture({
      match: { userMessage: "Generate a concise, single-line task title" },
      response: { content: "Task title" },
    });
    await llm.start();
    return new ScriptedMock(llm);
  }

  /** Base URL for OpenAI-style clients (`OPENAI_BASE_URL`). */
  get openaiBaseUrl(): string {
    return `${this.llm.url}/v1`;
  }

  /** Base URL for Anthropic clients (`ANTHROPIC_BASE_URL`, no `/v1`). */
  get anthropicBaseUrl(): string {
    return this.llm.url;
  }

  /** Answer a prompt with plain text. */
  reply(prompt: string | RegExp, text: string): this {
    this.llm.onMessage(prompt, { content: text });
    return this;
  }

  /**
   * Answer a prompt with one tool call, then answer the request that carries
   * the tool's result with `finalText`.
   */
  toolRound(
    prompt: string | RegExp,
    round: ToolRound,
    finalText: string,
  ): this {
    // aimock serves the first matching fixture. The follow-up request still
    // carries the original prompt, so the tool-result fixture must come first or
    // the prompt fixture would answer it again with the same tool call.
    this.llm.onToolResult(round.id, { content: finalText });
    this.llm.onMessage(prompt, {
      toolCalls: [{ id: round.id, name: round.name, arguments: round.args }],
    });
    return this;
  }

  /**
   * Add fixtures in match order (first match wins). Use `systemMessage` to tell
   * apart requests that carry the same user text, such as a parent agent, its
   * sub-agent, and the session-title calls.
   */
  script(entries: FixtureFileEntry[]): this {
    this.llm.addFixturesFromJSON(entries);
    return this;
  }

  /** Every request the server received, oldest first. */
  requests(): JournalEntry[] {
    return this.llm.getRequests();
  }

  requestsOn(wire: Wire): JournalEntry[] {
    return this.requests().filter((entry) =>
      entry.path.startsWith(wirePrefix[wire]),
    );
  }

  /** Requests whose body mentions `text` (history, prompt, or tool output). */
  requestsContaining(text: string): JournalEntry[] {
    return this.requests().filter((entry) =>
      JSON.stringify(entry.body ?? "").includes(text),
    );
  }

  /**
   * The conversation history of the real turn for a user prompt: among requests
   * whose messages include a user turn containing `text`, the one with the
   * longest history. Interactive clients also send empty warm-up frames and
   * title requests that merely quote the prompt, and those carry far less.
   */
  historyForUserText(text: string): HistoryMessage[] | undefined {
    let best: HistoryMessage[] | undefined;
    for (const entry of this.requests()) {
      const history = historyOf(entry.body);
      const mentions = history.some(
        (m) => m.role === "user" && textOf(m).includes(text),
      );
      if (mentions && (!best || history.length > best.length)) best = history;
    }
    return best;
  }

  /** Requests no fixture answered. A scenario expects none. */
  unmatched(): JournalEntry[] {
    return this.requests().filter((entry) => entry.response.status === 404);
  }

  /** One readable line per unmatched request, for assertion failure output. */
  unmatchedSummary(): string[] {
    return this.unmatched().map(
      (entry) => `${entry.method} ${entry.path} -> ${entry.response.status}`,
    );
  }

  clearRequests(): void {
    this.llm.clearRequests();
  }

  async stop(): Promise<void> {
    await this.llm.stop();
  }
}
