import { afterAll, beforeAll, beforeEach, expect, it } from "bun:test";

import { describeInContainer } from "./support/in-container.js";
import { ScriptedMock } from "./support/mock.js";

let mock: ScriptedMock;

describeInContainer("scripted mock server", () => {
  beforeAll(async () => {
    mock = await ScriptedMock.start();
  });
  afterAll(async () => {
    await mock.stop();
  });
  beforeEach(() => {
    mock.llm.clearFixtures();
    mock.clearRequests();
  });

  const post = (
    path: string,
    body: unknown,
    headers: Record<string, string> = {},
  ) =>
    fetch(`${mock.llm.url}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    });

  it("serves a Responses turn with a streamed tool call, then the final text", async () => {
    mock.toolRound(
      "list the files",
      { id: "call_ls", name: "shell", args: { cmd: "ls" } },
      "There are two files.",
    );
    const first = await post("/v1/responses", {
      model: "gpt-test",
      stream: true,
      input: [
        {
          role: "user",
          content: [{ type: "input_text", text: "list the files" }],
        },
      ],
    });
    const stream = await first.text();
    expect(first.status).toBe(200);
    expect(stream).toContain("event: response.output_item.added");
    expect(stream).toContain("call_ls");
    expect(stream).toContain("shell");

    const second = await post("/v1/responses", {
      model: "gpt-test",
      input: [
        {
          role: "user",
          content: [{ type: "input_text", text: "list the files" }],
        },
        {
          type: "function_call",
          call_id: "call_ls",
          name: "shell",
          arguments: '{"cmd":"ls"}',
        },
        {
          type: "function_call_output",
          call_id: "call_ls",
          output: "a.txt b.txt",
        },
      ],
    });
    expect(JSON.stringify(await second.json())).toContain(
      "There are two files.",
    );
  });

  it("serves an Anthropic Messages turn with a streamed tool_use, then the final text", async () => {
    mock.toolRound(
      "read the readme",
      { id: "toolu_read", name: "Read", args: { file_path: "README.md" } },
      "It is a readme.",
    );
    const first = await post(
      "/v1/messages",
      {
        model: "claude-test",
        max_tokens: 64,
        stream: true,
        messages: [{ role: "user", content: "read the readme" }],
      },
      { "anthropic-version": "2023-06-01", "x-api-key": "sk-aimock-test" },
    );
    const stream = await first.text();
    expect(first.status).toBe(200);
    expect(stream).toContain("content_block_start");
    expect(stream).toContain("toolu_read");

    const second = await post(
      "/v1/messages",
      {
        model: "claude-test",
        max_tokens: 64,
        messages: [
          { role: "user", content: "read the readme" },
          {
            role: "assistant",
            content: [
              {
                type: "tool_use",
                id: "toolu_read",
                name: "Read",
                input: { file_path: "README.md" },
              },
            ],
          },
          {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: "toolu_read",
                content: "# hi",
              },
            ],
          },
        ],
      },
      { "anthropic-version": "2023-06-01", "x-api-key": "sk-aimock-test" },
    );
    expect(JSON.stringify(await second.json())).toContain("It is a readme.");
  });

  it("journals every request per wire and finds the one carrying a string", async () => {
    mock.reply("hello", "hi");
    await post("/v1/responses", { model: "m", input: "hello there" });
    await post(
      "/v1/messages",
      {
        model: "m",
        max_tokens: 8,
        messages: [{ role: "user", content: "hello again" }],
      },
      { "anthropic-version": "2023-06-01" },
    );
    expect(mock.requests()).toHaveLength(2);
    expect(mock.requestsOn("responses")).toHaveLength(1);
    expect(mock.requestsOn("messages")).toHaveLength(1);
    expect(mock.requestsContaining("hello again")).toHaveLength(1);
    expect(mock.requestsContaining("never sent")).toHaveLength(0);
  });

  it("answers an unscripted request with a distinguishable error and journals it", async () => {
    mock.reply("known prompt", "known");
    const response = await post("/v1/responses", {
      model: "m",
      input: "an unscripted prompt",
    });
    expect(response.status).toBe(404);
    expect(mock.unmatched()).toHaveLength(1);
  });

  it("accepts a dummy sk-aimock- key on both wires", async () => {
    mock.reply("ping", "pong");
    const openai = await post(
      "/v1/responses",
      { model: "m", input: "ping" },
      { authorization: "Bearer sk-aimock-dummy" },
    );
    const claude = await post(
      "/v1/messages",
      {
        model: "m",
        max_tokens: 8,
        messages: [{ role: "user", content: "ping" }],
      },
      { "x-api-key": "sk-aimock-dummy", "anthropic-version": "2023-06-01" },
    );
    expect(openai.status).toBe(200);
    expect(claude.status).toBe(200);
  });
});
