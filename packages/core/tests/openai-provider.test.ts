import { describe, expect, it } from "vitest";
import { OpenAIResponsesProvider, type ModelTurnRequest, type ToolSpec } from "../src/index.js";

describe("OpenAIResponsesProvider", () => {
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
