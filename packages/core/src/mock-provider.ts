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

    if (text.startsWith("writefile:")) {
      const parsed = parseLeadingArgument(text.slice("writefile:".length));
      return {
        toolCalls: [
          {
            id: "mock-write-file-1",
            name: "write_file",
            input: { path: parsed.argument, content: parsed.rest }
          }
        ]
      };
    }

    if (text.startsWith("shell:")) {
      return {
        toolCalls: [
          {
            id: "mock-shell-1",
            name: "run_powershell",
            input: { command: text.slice("shell:".length).trim() }
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

function parseLeadingArgument(value: string): { argument: string; rest: string } {
  const trimmed = value.trim();
  const separator = trimmed.search(/\s/);
  if (separator < 0) {
    return { argument: trimmed, rest: "" };
  }
  return {
    argument: trimmed.slice(0, separator),
    rest: trimmed.slice(separator).trimStart()
  };
}
