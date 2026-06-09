import type { JsonSchemaObject, ModelProvider, ModelTurnRequest, ModelTurnResponse, TDMessage, ToolResult, ToolSpec } from "./types.js";
import { createInvalidProviderResponseError, createProviderApiError, readProviderJson } from "./provider-errors.js";

type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

interface OpenAIChatCompletionsProviderOptions {
  apiKey: string;
  model: string;
  baseUrl?: string;
  fetch?: FetchLike;
}

interface OpenAIChatToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

type OpenAIChatMessage =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content?: string | null; tool_calls?: OpenAIChatToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };

interface OpenAIChatResponsePayload {
  choices?: Array<{
    message?: OpenAIChatResponseMessage;
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
  };
  error?: {
    message?: string;
  };
}

interface OpenAIChatResponseMessage {
  role?: "assistant";
  content?: string | null;
  tool_calls?: OpenAIChatToolCall[];
}

export class OpenAIChatCompletionsProvider implements ModelProvider {
  private readonly baseUrl: string;
  private readonly fetchImpl: FetchLike;
  private readonly conversationBySession = new Map<string, OpenAIChatMessage[]>();

  constructor(private readonly options: OpenAIChatCompletionsProviderOptions) {
    if (!options.apiKey) {
      throw new Error(
        "OPENAI_API_KEY is not configured; set TOKENDANCE_GATEWAY_API_KEY for TokenDance Gateway or OPENAI_API_KEY for OpenAI-compatible Chat Completions."
      );
    }
    this.baseUrl = options.baseUrl ?? "https://api.openai.com/v1";
    this.fetchImpl = options.fetch ?? fetch;
  }

  async createTurn(request: ModelTurnRequest): Promise<ModelTurnResponse> {
    const messages = this.buildMessages(request);
    const response = await this.fetchImpl(`${this.baseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${this.options.apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: this.options.model,
        messages,
        tools: request.tools.map(toOpenAIChatTool),
        tool_choice: "auto"
      })
    });

    const { payload = {}, rawText } = await readProviderJson<OpenAIChatResponsePayload>(response);
    if (!response.ok) {
      throw createProviderApiError({
        provider: "openai-chat-completions",
        status: response.status,
        payload,
        rawText,
        fallbackMessage: `OpenAI Chat Completions API returned HTTP ${response.status}`
      });
    }

    const message = payload.choices?.[0]?.message;
    if (!message) {
      throw createInvalidProviderResponseError("openai-chat-completions", "OpenAI Chat Completions API response did not include an assistant message");
    }
    const assistantMessage = typeof message?.content === "string" ? message.content : undefined;
    const toolCalls = parseToolCalls(message?.tool_calls);
    if (!assistantMessage && toolCalls.length === 0) {
      throw createInvalidProviderResponseError("openai-chat-completions", "OpenAI Chat Completions API response did not include assistant output or tool calls");
    }
    this.conversationBySession.set(request.session.id, [...messages, toConversationAssistantMessage(message)]);

    return {
      assistantMessage,
      toolCalls,
      usage: {
        inputTokens: payload.usage?.prompt_tokens ?? 0,
        outputTokens: payload.usage?.completion_tokens ?? 0
      }
    };
  }

  private buildMessages(request: ModelTurnRequest): OpenAIChatMessage[] {
    const priorMessages = this.conversationBySession.get(request.session.id);
    const baseMessages = priorMessages ?? request.session.messages.map(toOpenAIChatMessage);
    if (request.toolResults.length === 0) {
      return baseMessages;
    }
    return [...baseMessages, ...request.toolResults.map(toOpenAIChatToolResult)];
  }
}

function toOpenAIChatTool(tool: ToolSpec): Record<string, unknown> {
  return {
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema ?? openObjectSchema()
    }
  };
}

function toOpenAIChatMessage(message: TDMessage): OpenAIChatMessage {
  if (message.role === "tool" && message.toolCallId) {
    return { role: "tool", tool_call_id: message.toolCallId, content: message.content };
  }
  if (message.role === "assistant") {
    return { role: "assistant", content: message.content };
  }
  return {
    role: message.role === "system" ? "system" : "user",
    content: message.content
  };
}

function toOpenAIChatToolResult(result: ToolResult): OpenAIChatMessage {
  return {
    role: "tool",
    tool_call_id: result.callId,
    content: JSON.stringify(result.ok ? result.output ?? null : { error: result.error ?? "Tool failed" })
  };
}

function toConversationAssistantMessage(message: OpenAIChatResponseMessage | undefined): OpenAIChatMessage {
  return {
    role: "assistant",
    content: typeof message?.content === "string" ? message.content : null,
    tool_calls: message?.tool_calls
  };
}

function parseToolCalls(toolCalls: OpenAIChatToolCall[] | undefined): ModelTurnResponse["toolCalls"] {
  return (toolCalls ?? []).map((call) => ({
    id: call.id,
    name: call.function.name,
    input: parseArguments(call.function.arguments)
  }));
}

function parseArguments(argumentsText: string): unknown {
  if (!argumentsText.trim()) {
    return {};
  }
  try {
    return JSON.parse(argumentsText);
  } catch {
    return { raw: argumentsText };
  }
}

function openObjectSchema(): JsonSchemaObject {
  return {
    type: "object",
    properties: {},
    additionalProperties: true
  };
}
