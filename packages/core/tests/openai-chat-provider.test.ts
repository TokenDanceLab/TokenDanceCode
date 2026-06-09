import { describe, expect, it } from "vitest";
import { OpenAIChatCompletionsProvider, type ModelTurnRequest, type ToolSpec } from "../src/index.js";

describe("OpenAIChatCompletionsProvider", () => {
  it("creates a Chat Completions request and parses assistant text", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const provider = new OpenAIChatCompletionsProvider({
      apiKey: "test-key",
      model: "gpt-test",
      baseUrl: "https://api.test/v1",
      fetch: async (url, init) => {
        calls.push({ url: String(url), init });
        return jsonResponse({
          choices: [{ message: { role: "assistant", content: "hello" } }],
          usage: { prompt_tokens: 3, completion_tokens: 2 }
        });
      }
    });

    const response = await provider.createTurn(baseRequest());
    const body = JSON.parse(String(calls[0]?.init?.body));

    expect(calls[0]?.url).toBe("https://api.test/v1/chat/completions");
    expect(calls[0]?.init?.headers).toMatchObject({ Authorization: "Bearer test-key" });
    expect(body).toMatchObject({
      model: "gpt-test",
      messages: [{ role: "user", content: "hello" }],
      tool_choice: "auto"
    });
    expect(body.tools[0]).toMatchObject({
      type: "function",
      function: {
        name: "echo",
        parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"] }
      }
    });
    expect(response).toEqual({
      assistantMessage: "hello",
      toolCalls: [],
      usage: { inputTokens: 3, outputTokens: 2 }
    });
  });

  it("parses tool_calls and sends tool results on the next turn", async () => {
    const bodies: unknown[] = [];
    const provider = new OpenAIChatCompletionsProvider({
      apiKey: "test-key",
      model: "gpt-test",
      baseUrl: "https://api.test/v1",
      fetch: async (_url, init) => {
        bodies.push(JSON.parse(String(init?.body)));
        if (bodies.length === 1) {
          return jsonResponse({
            choices: [
              {
                message: {
                  role: "assistant",
                  content: null,
                  tool_calls: [
                    {
                      id: "call-1",
                      type: "function",
                      function: { name: "echo", arguments: "{\"text\":\"hi\"}" }
                    }
                  ]
                }
              }
            ]
          });
        }
        return jsonResponse({ choices: [{ message: { role: "assistant", content: "done" } }] });
      }
    });

    const first = await provider.createTurn(baseRequest());
    const second = await provider.createTurn({
      ...baseRequest(),
      toolResults: [{ callId: "call-1", toolName: "echo", ok: true, output: { text: "hi" } }]
    });

    expect(first.toolCalls).toEqual([{ id: "call-1", name: "echo", input: { text: "hi" } }]);
    expect(bodies[1]).toMatchObject({
      messages: [
        { role: "user", content: "hello" },
        {
          role: "assistant",
          tool_calls: [
            {
              id: "call-1",
              type: "function",
              function: { name: "echo", arguments: "{\"text\":\"hi\"}" }
            }
          ]
        },
        { role: "tool", tool_call_id: "call-1", content: "{\"text\":\"hi\"}" }
      ]
    });
    expect(second.assistantMessage).toBe("done");
  });

  it("surfaces API errors", async () => {
    const provider = new OpenAIChatCompletionsProvider({
      apiKey: "test-key",
      model: "gpt-test",
      fetch: async () => jsonResponse({ error: { message: "bad request", type: "invalid_request_error", code: "bad_request" } }, { status: 400 })
    });

    await expect(provider.createTurn(baseRequest())).rejects.toMatchObject({
      name: "ProviderApiError",
      provider: "openai-chat-completions",
      protocol: "openai-chat-completions",
      status: 400,
      type: "invalid_request_error",
      code: "bad_request",
      message: "[openai-chat-completions] HTTP 400 bad_request: bad request"
    });
  });

  it("normalizes TokenDance Gateway HTTP errors", async () => {
    const provider = new OpenAIChatCompletionsProvider({
      apiKey: "gateway-key",
      model: "deepseek-v4-pro",
      baseUrl: "https://api.vectorcontrol.tech/v1",
      fetch: async () => jsonResponse({ error: { message: "quota exceeded", code: "insufficient_quota" } }, { status: 429 })
    });

    await expect(provider.createTurn(baseRequest())).rejects.toMatchObject({
      name: "ProviderApiError",
      provider: "openai-chat-completions",
      status: 429,
      code: "insufficient_quota",
      message: "[openai-chat-completions] HTTP 429 insufficient_quota: quota exceeded"
    });
  });

  it("normalizes TokenDance Gateway string error payloads", async () => {
    const provider = new OpenAIChatCompletionsProvider({
      apiKey: "gateway-key",
      model: "deepseek-v4-pro",
      baseUrl: "https://api.vectorcontrol.tech/v1",
      fetch: async () => jsonResponse({ error: "quota exceeded" }, { status: 429 })
    });

    await expect(provider.createTurn(baseRequest())).rejects.toMatchObject({
      name: "ProviderApiError",
      provider: "openai-chat-completions",
      status: 429,
      message: "[openai-chat-completions] HTTP 429: quota exceeded"
    });
  });

  it("rejects successful Chat Completions payloads without a message", async () => {
    const provider = new OpenAIChatCompletionsProvider({
      apiKey: "test-key",
      model: "gpt-test",
      fetch: async () => jsonResponse({ choices: [] })
    });

    await expect(provider.createTurn(baseRequest())).rejects.toMatchObject({
      name: "ProviderApiError",
      provider: "openai-chat-completions",
      protocol: "openai-chat-completions",
      status: 200,
      type: "invalid_provider_response",
      message: "[openai-chat-completions] HTTP 200 invalid_provider_response: OpenAI Chat Completions API response did not include an assistant message"
    });
  });
});

function baseRequest(): ModelTurnRequest {
  return {
    session: {
      id: "session-1",
      cwd: "C:/repo",
      createdAt: "2026-06-09T00:00:00.000Z",
      updatedAt: "2026-06-09T00:00:00.000Z",
      permissionMode: "default",
      messages: [{ role: "user", content: "hello" }]
    },
    tools: [echoTool()],
    toolResults: []
  };
}

function echoTool(): ToolSpec {
  return {
    name: "echo",
    description: "Echo text",
    inputSchema: {
      type: "object",
      properties: { text: { type: "string" } },
      required: ["text"]
    },
    risk: "read",
    concurrency: "parallel_safe",
    parse: (input) => input,
    execute: async (input) => input
  };
}

function jsonResponse(body: unknown, init: { status?: number } = {}): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { "Content-Type": "application/json" }
  });
}
