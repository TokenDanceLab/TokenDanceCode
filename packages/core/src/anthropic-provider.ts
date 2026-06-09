import type { JsonSchemaObject, ModelProvider, ModelTurnRequest, ModelTurnResponse, TDMessage, ToolResult, ToolSpec } from "./types.js";
import { createProviderApiError, readProviderJson } from "./provider-errors.js";

type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

interface AnthropicMessagesProviderOptions {
  apiKey: string;
  model: string;
  baseUrl?: string;
  maxTokens?: number;
  anthropicVersion?: string;
  fetch?: FetchLike;
}

type AnthropicContentBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | { type: "tool_result"; tool_use_id: string; content: string; is_error?: boolean };

interface AnthropicMessage {
  role: "user" | "assistant";
  content: string | AnthropicContentBlock[];
}

interface AnthropicResponsePayload {
  content?: AnthropicContentBlock[];
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
  };
  error?: {
    message?: string;
  };
}

export class AnthropicMessagesProvider implements ModelProvider {
  private readonly baseUrl: string;
  private readonly fetchImpl: FetchLike;
  private readonly maxTokens: number;
  private readonly version: string;
  private readonly conversationBySession = new Map<string, AnthropicMessage[]>();

  constructor(private readonly options: AnthropicMessagesProviderOptions) {
    if (!options.apiKey) {
      throw new Error("ANTHROPIC_API_KEY is not configured");
    }
    this.baseUrl = options.baseUrl ?? "https://api.anthropic.com";
    this.fetchImpl = options.fetch ?? fetch;
    this.maxTokens = options.maxTokens ?? 4096;
    this.version = options.anthropicVersion ?? "2023-06-01";
  }

  async createTurn(request: ModelTurnRequest): Promise<ModelTurnResponse> {
    const messages = this.buildMessages(request);
    const response = await this.fetchImpl(`${this.baseUrl.replace(/\/$/, "")}/v1/messages`, {
      method: "POST",
      headers: {
        "x-api-key": this.options.apiKey,
        "anthropic-version": this.version,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: this.options.model,
        max_tokens: this.maxTokens,
        system: toAnthropicSystem(request.session.messages),
        messages,
        tools: request.tools.map(toAnthropicTool)
      })
    });

    const { payload = {}, rawText } = await readProviderJson<AnthropicResponsePayload>(response);
    if (!response.ok) {
      throw createProviderApiError({
        provider: "anthropic-messages",
        status: response.status,
        payload,
        rawText,
        fallbackMessage: `Anthropic Messages API returned HTTP ${response.status}`
      });
    }

    const toolCalls = parseToolCalls(payload);
    const assistantMessage = parseAssistantText(payload);
    this.conversationBySession.set(request.session.id, [...messages, { role: "assistant", content: payload.content ?? [] }]);

    return {
      assistantMessage,
      toolCalls,
      usage: {
        inputTokens: payload.usage?.input_tokens ?? 0,
        outputTokens: payload.usage?.output_tokens ?? 0
      }
    };
  }

  private buildMessages(request: ModelTurnRequest): AnthropicMessage[] {
    const priorMessages = this.conversationBySession.get(request.session.id);
    const baseMessages = priorMessages ?? toAnthropicMessages(request.session.messages);
    if (request.toolResults.length === 0) {
      return baseMessages;
    }
    return [...baseMessages, { role: "user", content: request.toolResults.map(toToolResultBlock) }];
  }
}

function toAnthropicSystem(messages: TDMessage[]): string | undefined {
  const system = messages
    .filter((message) => message.role === "system")
    .map((message) => message.content)
    .join("\n");
  return system || undefined;
}

function toAnthropicMessages(messages: TDMessage[]): AnthropicMessage[] {
  return messages
    .filter((message) => message.role !== "system")
    .map((message) => ({
      role: message.role === "assistant" ? "assistant" : "user",
      content: message.content
    }));
}

function toAnthropicTool(tool: ToolSpec): Record<string, unknown> {
  return {
    name: tool.name,
    description: tool.description,
    input_schema: tool.inputSchema ?? openObjectSchema()
  };
}

function toToolResultBlock(result: ToolResult): AnthropicContentBlock {
  return {
    type: "tool_result",
    tool_use_id: result.callId,
    content: JSON.stringify(result.ok ? result.output ?? null : { error: result.error ?? "Tool failed" }),
    is_error: result.ok ? undefined : true
  };
}

function parseAssistantText(payload: AnthropicResponsePayload): string | undefined {
  const text = (payload.content ?? [])
    .filter((block): block is { type: "text"; text: string } => block.type === "text")
    .map((block) => block.text)
    .join("");
  return text || undefined;
}

function parseToolCalls(payload: AnthropicResponsePayload): ModelTurnResponse["toolCalls"] {
  return (payload.content ?? [])
    .filter((block): block is { type: "tool_use"; id: string; name: string; input: unknown } => block.type === "tool_use")
    .map((block) => ({
      id: block.id,
      name: block.name,
      input: block.input ?? {}
    }));
}

function openObjectSchema(): JsonSchemaObject {
  return {
    type: "object",
    properties: {},
    additionalProperties: true
  };
}
