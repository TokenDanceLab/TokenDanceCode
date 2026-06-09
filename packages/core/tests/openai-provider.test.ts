import { describe, expect, it } from "vitest";
import { OpenAIResponsesProvider, type ModelTurnRequest, type ToolSpec } from "../src/index.js";

describe("OpenAIResponsesProvider", () => {
  it("rejects missing or blank API keys before making requests", () => {
    expect(() => new OpenAIResponsesProvider({ apiKey: "", model: "gpt-test" })).toThrow("OPENAI_API_KEY is not configured");
    expect(() => new OpenAIResponsesProvider({ apiKey: "   ", model: "gpt-test" })).toThrow("OPENAI_API_KEY is not configured");
  });

  it("creates a Responses API request and parses assistant text", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const provider = new OpenAIResponsesProvider({
      apiKey: "test-key",
      model: "gpt-test",
      baseUrl: "https://api.test/v1",
      fetch: async (url, init) => {
        calls.push({ url: String(url), init });
        return jsonResponse({
          output_text: "hello",
          usage: { input_tokens: 3, output_tokens: 2 }
        });
      }
    });

    const response = await provider.createTurn(baseRequest());
    const body = JSON.parse(String(calls[0]?.init?.body));

    expect(calls[0]?.url).toBe("https://api.test/v1/responses");
    expect(calls[0]?.init?.headers).toMatchObject({ Authorization: "Bearer test-key" });
    expect(body).toMatchObject({
      model: "gpt-test",
      input: [{ role: "user", content: "hello" }],
      tool_choice: "auto",
      parallel_tool_calls: true
    });
    expect(body.tools[0]).toMatchObject({
      type: "function",
      name: "echo",
      parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"] }
    });
    expect(response).toEqual({
      assistantMessage: "hello",
      toolCalls: [],
      usage: { inputTokens: 3, outputTokens: 2 }
    });
  });

  it("parses function calls and sends function_call_output on the next turn", async () => {
    const bodies: unknown[] = [];
    const provider = new OpenAIResponsesProvider({
      apiKey: "test-key",
      model: "gpt-test",
      baseUrl: "https://api.test/v1",
      fetch: async (_url, init) => {
        bodies.push(JSON.parse(String(init?.body)));
        if (bodies.length === 1) {
          return jsonResponse({
            output: [{ type: "function_call", call_id: "call-1", name: "echo", arguments: "{\"text\":\"hi\"}" }]
          });
        }
        return jsonResponse({ output: [{ type: "message", content: [{ type: "output_text", text: "done" }] }] });
      }
    });

    const first = await provider.createTurn(baseRequest());
    const second = await provider.createTurn({
      ...baseRequest(),
      toolResults: [{ callId: "call-1", toolName: "echo", ok: true, output: { text: "hi" } }]
    });

    expect(first.toolCalls).toEqual([{ id: "call-1", name: "echo", input: { text: "hi" } }]);
    expect(bodies[1]).toMatchObject({
      input: [
        { role: "user", content: "hello" },
        { type: "function_call", call_id: "call-1", name: "echo", arguments: "{\"text\":\"hi\"}" },
        { type: "function_call_output", call_id: "call-1", output: "{\"text\":\"hi\"}" }
      ]
    });
    expect(second.assistantMessage).toBe("done");
  });

  it("does not duplicate prior function_call_output items during multi-step tool loops", async () => {
    const bodies: Array<{ input: Array<Record<string, unknown>> }> = [];
    const provider = new OpenAIResponsesProvider({
      apiKey: "test-key",
      model: "gpt-test",
      baseUrl: "https://api.test/v1",
      fetch: async (_url, init) => {
        bodies.push(JSON.parse(String(init?.body)));
        if (bodies.length === 1) {
          return jsonResponse({
            output: [{ type: "function_call", call_id: "call-1", name: "echo", arguments: "{\"text\":\"first\"}" }]
          });
        }
        if (bodies.length === 2) {
          return jsonResponse({
            output: [{ type: "function_call", call_id: "call-2", name: "echo", arguments: "{\"text\":\"second\"}" }]
          });
        }
        return jsonResponse({ output: [{ type: "message", content: [{ type: "output_text", text: "done" }] }] });
      }
    });

    await provider.createTurn(baseRequest());
    await provider.createTurn({
      ...baseRequest(),
      toolResults: [{ callId: "call-1", toolName: "echo", ok: true, output: { text: "first" } }]
    });
    await provider.createTurn({
      ...baseRequest(),
      toolResults: [
        { callId: "call-1", toolName: "echo", ok: true, output: { text: "first" } },
        { callId: "call-2", toolName: "echo", ok: true, output: { text: "second" } }
      ]
    });

    const thirdInput = bodies[2]?.input ?? [];
    expect(thirdInput.filter((item) => item.type === "function_call_output" && item.call_id === "call-1")).toHaveLength(1);
    expect(thirdInput.filter((item) => item.type === "function_call_output" && item.call_id === "call-2")).toHaveLength(1);
    expect(thirdInput).toMatchObject([
      { role: "user", content: "hello" },
      { type: "function_call", call_id: "call-1", name: "echo" },
      { type: "function_call_output", call_id: "call-1", output: "{\"text\":\"first\"}" },
      { type: "function_call", call_id: "call-2", name: "echo" },
      { type: "function_call_output", call_id: "call-2", output: "{\"text\":\"second\"}" }
    ]);
  });

  it("uses fresh session messages for a later user turn after a tool loop completes", async () => {
    const bodies: Array<{ input: Array<Record<string, unknown>> }> = [];
    const provider = new OpenAIResponsesProvider({
      apiKey: "test-key",
      model: "gpt-test",
      baseUrl: "https://api.test/v1",
      fetch: async (_url, init) => {
        bodies.push(JSON.parse(String(init?.body)));
        if (bodies.length === 1) {
          return jsonResponse({
            output: [{ type: "function_call", call_id: "call-1", name: "echo", arguments: "{\"text\":\"hi\"}" }]
          });
        }
        return jsonResponse({ output: [{ type: "message", content: [{ type: "output_text", text: "done" }] }] });
      }
    });

    await provider.createTurn(baseRequest());
    await provider.createTurn({
      ...baseRequest(),
      toolResults: [{ callId: "call-1", toolName: "echo", ok: true, output: { text: "hi" } }]
    });
    await provider.createTurn({
      ...baseRequest(),
      session: {
        ...baseRequest().session,
        messages: [
          { role: "user", content: "hello" },
          { role: "assistant", content: "done" },
          { role: "user", content: "next question" }
        ]
      }
    });

    expect(bodies[2]?.input).toEqual([
      { role: "user", content: "hello" },
      { role: "assistant", content: "done" },
      { role: "user", content: "next question" }
    ]);
  });

  it("surfaces API errors", async () => {
    const provider = new OpenAIResponsesProvider({
      apiKey: "test-key",
      model: "gpt-test",
      fetch: async () => jsonResponse({ error: { message: "bad request", type: "invalid_request_error", code: "bad_request" } }, { status: 400 })
    });

    await expect(provider.createTurn(baseRequest())).rejects.toMatchObject({
      name: "ProviderApiError",
      provider: "openai-responses",
      protocol: "openai-responses",
      status: 400,
      type: "invalid_request_error",
      code: "bad_request",
      message: "[openai-responses] HTTP 400 bad_request: bad request"
    });
  });

  it("normalizes non-JSON HTTP errors", async () => {
    const provider = new OpenAIResponsesProvider({
      apiKey: "test-key",
      model: "gpt-test",
      fetch: async () => new Response("bad gateway", { status: 502 })
    });

    await expect(provider.createTurn(baseRequest())).rejects.toMatchObject({
      name: "ProviderApiError",
      provider: "openai-responses",
      status: 502,
      message: "[openai-responses] HTTP 502: bad gateway"
    });
  });

  it("normalizes fetch failures as provider transport errors", async () => {
    const provider = new OpenAIResponsesProvider({
      apiKey: "test-key",
      model: "gpt-test",
      fetch: async () => {
        throw new TypeError("fetch failed");
      }
    });

    await expect(provider.createTurn(baseRequest())).rejects.toMatchObject({
      name: "ProviderApiError",
      provider: "openai-responses",
      protocol: "openai-responses",
      status: 0,
      type: "provider_transport_error",
      message: "[openai-responses] HTTP 0 provider_transport_error: fetch failed"
    });
  });

  it("normalizes aborted fetches as provider timeout errors", async () => {
    const provider = new OpenAIResponsesProvider({
      apiKey: "test-key",
      model: "gpt-test",
      fetch: async () => {
        throw new DOMException("The operation was aborted.", "AbortError");
      }
    });

    await expect(provider.createTurn(baseRequest())).rejects.toMatchObject({
      name: "ProviderApiError",
      provider: "openai-responses",
      status: 0,
      type: "provider_timeout",
      message: "[openai-responses] HTTP 0 provider_timeout: The operation was aborted."
    });
  });

  it("rejects malformed successful JSON with a diagnostic error", async () => {
    const provider = new OpenAIResponsesProvider({
      apiKey: "test-key",
      model: "gpt-test",
      fetch: async () => new Response("{", { status: 200, headers: { "Content-Type": "application/json" } })
    });

    await expect(provider.createTurn(baseRequest())).rejects.toMatchObject({
      name: "ProviderApiError",
      provider: "openai-responses",
      protocol: "openai-responses",
      status: 200,
      type: "malformed_provider_response",
      message: "[openai-responses] HTTP 200 malformed_provider_response: Provider returned malformed JSON: {"
    });
  });

  it("rejects successful Responses payloads without assistant output or tool calls", async () => {
    const provider = new OpenAIResponsesProvider({
      apiKey: "test-key",
      model: "gpt-test",
      fetch: async () => jsonResponse({})
    });

    await expect(provider.createTurn(baseRequest())).rejects.toMatchObject({
      name: "ProviderApiError",
      provider: "openai-responses",
      protocol: "openai-responses",
      status: 200,
      type: "invalid_provider_response",
      message: "[openai-responses] HTTP 200 invalid_provider_response: OpenAI Responses API response did not include assistant output or tool calls"
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
