import { describe, expect, it } from "vitest";
import { AnthropicMessagesProvider, type ModelTurnRequest, type ToolSpec } from "../src/index.js";

describe("AnthropicMessagesProvider", () => {
  it("rejects missing or blank API keys before making requests", () => {
    expect(() => new AnthropicMessagesProvider({ apiKey: "", model: "claude-test" })).toThrow("ANTHROPIC_API_KEY is not configured");
    expect(() => new AnthropicMessagesProvider({ apiKey: "   ", model: "claude-test" })).toThrow("ANTHROPIC_API_KEY is not configured");
  });

  it("creates a Messages API request and parses assistant text", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const provider = new AnthropicMessagesProvider({
      apiKey: "test-key",
      model: "claude-test",
      baseUrl: "https://anthropic.test",
      maxTokens: 123,
      fetch: async (url, init) => {
        calls.push({ url: String(url), init });
        return jsonResponse({
          content: [{ type: "text", text: "hello" }],
          usage: { input_tokens: 4, output_tokens: 2 }
        });
      }
    });

    const response = await provider.createTurn(baseRequest());
    const body = JSON.parse(String(calls[0]?.init?.body));

    expect(calls[0]?.url).toBe("https://anthropic.test/v1/messages");
    expect(calls[0]?.init?.headers).toMatchObject({
      "x-api-key": "test-key",
      "anthropic-version": "2023-06-01"
    });
    expect(body).toMatchObject({
      model: "claude-test",
      max_tokens: 123,
      system: "system prompt",
      messages: [{ role: "user", content: "hello" }],
      tools: [
        {
          name: "echo",
          input_schema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] }
        }
      ]
    });
    expect(response).toEqual({
      assistantMessage: "hello",
      toolCalls: [],
      usage: { inputTokens: 4, outputTokens: 2 }
    });
  });

  it("parses tool_use blocks and sends tool_result blocks on the next turn", async () => {
    const bodies: unknown[] = [];
    const provider = new AnthropicMessagesProvider({
      apiKey: "test-key",
      model: "claude-test",
      baseUrl: "https://anthropic.test",
      fetch: async (_url, init) => {
        bodies.push(JSON.parse(String(init?.body)));
        if (bodies.length === 1) {
          return jsonResponse({
            content: [{ type: "tool_use", id: "toolu-1", name: "echo", input: { text: "hi" } }]
          });
        }
        return jsonResponse({ content: [{ type: "text", text: "done" }] });
      }
    });

    const first = await provider.createTurn(baseRequest());
    const second = await provider.createTurn({
      ...baseRequest(),
      toolResults: [{ callId: "toolu-1", toolName: "echo", ok: true, output: { text: "hi" } }]
    });

    expect(first.toolCalls).toEqual([{ id: "toolu-1", name: "echo", input: { text: "hi" } }]);
    expect(bodies[1]).toMatchObject({
      messages: [
        { role: "user", content: "hello" },
        { role: "assistant", content: [{ type: "tool_use", id: "toolu-1", name: "echo", input: { text: "hi" } }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu-1", content: "{\"text\":\"hi\"}" }] }
      ]
    });
    expect(second.assistantMessage).toBe("done");
  });

  it("surfaces API errors", async () => {
    const provider = new AnthropicMessagesProvider({
      apiKey: "test-key",
      model: "claude-test",
      fetch: async () => jsonResponse({ error: { message: "auth failed", type: "authentication_error" } }, { status: 401 })
    });

    await expect(provider.createTurn(baseRequest())).rejects.toMatchObject({
      name: "ProviderApiError",
      provider: "anthropic-messages",
      protocol: "anthropic-messages",
      status: 401,
      type: "authentication_error",
      message: "[anthropic-messages] HTTP 401 authentication_error: auth failed"
    });
  });

  it("normalizes non-JSON HTTP errors", async () => {
    const provider = new AnthropicMessagesProvider({
      apiKey: "test-key",
      model: "claude-test",
      fetch: async () => new Response("bad gateway", { status: 502 })
    });

    await expect(provider.createTurn(baseRequest())).rejects.toMatchObject({
      name: "ProviderApiError",
      provider: "anthropic-messages",
      status: 502,
      message: "[anthropic-messages] HTTP 502: bad gateway"
    });
  });

  it("normalizes fetch failures as provider transport errors", async () => {
    const provider = new AnthropicMessagesProvider({
      apiKey: "test-key",
      model: "claude-test",
      fetch: async () => {
        throw new TypeError("fetch failed");
      }
    });

    await expect(provider.createTurn(baseRequest())).rejects.toMatchObject({
      name: "ProviderApiError",
      provider: "anthropic-messages",
      protocol: "anthropic-messages",
      status: 0,
      type: "provider_transport_error",
      message: "[anthropic-messages] HTTP 0 provider_transport_error: fetch failed"
    });
  });

  it("normalizes aborted fetches as provider timeout errors", async () => {
    const provider = new AnthropicMessagesProvider({
      apiKey: "test-key",
      model: "claude-test",
      fetch: async () => {
        throw new DOMException("The operation was aborted.", "AbortError");
      }
    });

    await expect(provider.createTurn(baseRequest())).rejects.toMatchObject({
      name: "ProviderApiError",
      provider: "anthropic-messages",
      status: 0,
      type: "provider_timeout",
      message: "[anthropic-messages] HTTP 0 provider_timeout: The operation was aborted."
    });
  });

  it("rejects malformed successful JSON with a diagnostic error", async () => {
    const provider = new AnthropicMessagesProvider({
      apiKey: "test-key",
      model: "claude-test",
      fetch: async () => new Response("{", { status: 200, headers: { "Content-Type": "application/json" } })
    });

    await expect(provider.createTurn(baseRequest())).rejects.toMatchObject({
      name: "ProviderApiError",
      provider: "anthropic-messages",
      protocol: "anthropic-messages",
      status: 200,
      type: "malformed_provider_response",
      message: "[anthropic-messages] HTTP 200 malformed_provider_response: Provider returned malformed JSON: {"
    });
  });

  it("rejects successful Messages payloads without assistant content", async () => {
    const provider = new AnthropicMessagesProvider({
      apiKey: "test-key",
      model: "claude-test",
      fetch: async () => jsonResponse({})
    });

    await expect(provider.createTurn(baseRequest())).rejects.toMatchObject({
      name: "ProviderApiError",
      provider: "anthropic-messages",
      protocol: "anthropic-messages",
      status: 200,
      type: "invalid_provider_response",
      message: "[anthropic-messages] HTTP 200 invalid_provider_response: Anthropic Messages API response did not include assistant content"
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
      messages: [
        { role: "system", content: "system prompt" },
        { role: "user", content: "hello" }
      ]
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
