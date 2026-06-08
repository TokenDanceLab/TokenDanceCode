import type { ModelProvider, ModelTurnRequest, ModelTurnResponse } from "./types.js";

export class MockProvider implements ModelProvider {
  async createTurn(request: ModelTurnRequest): Promise<ModelTurnResponse> {
    if (request.toolResults.length > 0) {
      const result = request.toolResults.at(-1);
      return {
        assistantMessage: `Tool result: ${JSON.stringify(result?.output ?? result?.error)}`,
        toolCalls: [],
        usage: { inputTokens: 1, outputTokens: 10 }
      };
    }

    const last = [...request.session.messages].reverse().find((message) => message.role === "user");
    const text = last?.content ?? "";
    if (text.startsWith("echo:")) {
      return {
        toolCalls: [
          {
            id: "mock-echo-1",
            name: "echo",
            input: { text: text.slice("echo:".length).trim() }
          }
        ]
      };
    }

    if (text.startsWith("missingtool:")) {
      return {
        toolCalls: [
          {
            id: "mock-missing-tool-1",
            name: "missing_tool",
            input: { text: text.slice("missingtool:".length).trim() }
          }
        ]
      };
    }

    return {
      assistantMessage: `Mock response: ${text}`,
      toolCalls: [],
      usage: { inputTokens: text.length, outputTokens: 5 }
    };
  }
}
