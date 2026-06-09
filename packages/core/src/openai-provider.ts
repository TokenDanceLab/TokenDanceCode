import type { JsonSchemaObject, ModelProvider, ModelTurnRequest, ModelTurnResponse, ToolResult, ToolSpec } from "./types.js";
import {
  createInvalidProviderResponseError,
  createMalformedProviderResponseError,
  createProviderApiError,
  createProviderTransportError,
  readProviderJson
} from "./provider-errors.js";

type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

interface OpenAIResponsesProviderOptions {
  apiKey: string;
  model: string;
  baseUrl?: string;
  fetch?: FetchLike;
}

type OpenAIInputItem =
  | { role: "system" | "user" | "assistant"; content: string }
  | { type: "function_call"; id?: string; call_id: string; name: string; arguments: string }
  | { type: "function_call_output"; call_id: string; output: string };

interface OpenAIResponseOutputMessage {
  type: "message";
  role?: string;
  content?: Array<{ type: string; text?: string }>;
}

interface OpenAIResponseFunctionCall {
  type: "function_call";
  id?: string;
  call_id: string;
  name: string;
  arguments: string;
}

type OpenAIResponseOutputItem = OpenAIResponseOutputMessage | OpenAIResponseFunctionCall | Record<string, unknown>;

interface OpenAIResponsePayload {
  output?: OpenAIResponseOutputItem[];
  output_text?: string;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
  };
  error?: { message?: string };
}

export class OpenAIResponsesProvider implements ModelProvider {
  private readonly baseUrl: string;
  private readonly fetchImpl: FetchLike;
  private readonly conversationBySession = new Map<string, OpenAIInputItem[]>();

  constructor(private readonly options: OpenAIResponsesProviderOptions) {
    if (!options.apiKey.trim()) {
      throw new Error("OPENAI_API_KEY is not configured");
    }
    this.baseUrl = options.baseUrl ?? "https://api.openai.com/v1";
    this.fetchImpl = options.fetch ?? fetch;
  }

  async createTurn(request: ModelTurnRequest): Promise<ModelTurnResponse> {
    const input = this.buildInput(request);
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl.replace(/\/$/, "")}/responses`, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${this.options.apiKey}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          model: this.options.model,
          input,
          tools: request.tools.map(toOpenAITool),
          tool_choice: "auto",
          parallel_tool_calls: true
        })
      });
    } catch (error) {
      throw createProviderTransportError("openai-responses", error);
    }

    const { payload = {}, rawText, malformed } = await readProviderJson<OpenAIResponsePayload>(response);
    if (!response.ok) {
      throw createProviderApiError({
        provider: "openai-responses",
        status: response.status,
        payload,
        rawText,
        fallbackMessage: `OpenAI Responses API returned HTTP ${response.status}`
      });
    }
    if (malformed) {
      throw createMalformedProviderResponseError("openai-responses", rawText);
    }

    const toolCalls = parseToolCalls(payload);
    const assistantMessage = parseAssistantText(payload);
    if (!assistantMessage && toolCalls.length === 0) {
      throw createInvalidProviderResponseError("openai-responses", "OpenAI Responses API response did not include assistant output or tool calls");
    }
    const outputItems = (payload.output ?? []).filter(isConversationOutputItem);
    this.conversationBySession.set(request.session.id, [...input, ...outputItems]);

    return {
      assistantMessage,
      toolCalls,
      usage: {
        inputTokens: payload.usage?.input_tokens ?? 0,
        outputTokens: payload.usage?.output_tokens ?? 0
      }
    };
  }

  private buildInput(request: ModelTurnRequest): OpenAIInputItem[] {
    const priorInput = this.conversationBySession.get(request.session.id);
    const baseInput = priorInput ?? request.session.messages.map((message) => ({
      role: message.role === "tool" ? "user" : message.role,
      content: message.content
    } satisfies OpenAIInputItem));

    if (request.toolResults.length === 0) {
      return baseInput;
    }

    return [...baseInput, ...request.toolResults.map(toFunctionCallOutput)];
  }
}

function toOpenAITool(tool: ToolSpec): Record<string, unknown> {
  return {
    type: "function",
    name: tool.name,
    description: tool.description,
    parameters: tool.inputSchema ?? openObjectSchema()
  };
}

function toFunctionCallOutput(result: ToolResult): OpenAIInputItem {
  return {
    type: "function_call_output",
    call_id: result.callId,
    output: JSON.stringify(result.ok ? result.output ?? null : { error: result.error ?? "Tool failed" })
  };
}

function parseToolCalls(payload: OpenAIResponsePayload): ModelTurnResponse["toolCalls"] {
  return (payload.output ?? [])
    .filter((item): item is OpenAIResponseFunctionCall => item.type === "function_call")
    .map((item) => ({
      id: item.call_id || item.id || item.name,
      name: item.name,
      input: parseArguments(item.arguments)
    }));
}

function parseAssistantText(payload: OpenAIResponsePayload): string | undefined {
  if (payload.output_text) {
    return payload.output_text;
  }

  const parts: string[] = [];
  for (const item of payload.output ?? []) {
    if (!isOutputMessage(item)) {
      continue;
    }
    for (const content of item.content ?? []) {
      if (content.type === "output_text" && typeof content.text === "string") {
        parts.push(content.text);
      }
    }
  }
  return parts.length > 0 ? parts.join("") : undefined;
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

function isConversationOutputItem(item: OpenAIResponseOutputItem): item is OpenAIInputItem {
  return item.type === "function_call";
}

function isOutputMessage(item: OpenAIResponseOutputItem): item is OpenAIResponseOutputMessage {
  return item.type === "message";
}

function openObjectSchema(): JsonSchemaObject {
  return {
    type: "object",
    properties: {},
    additionalProperties: true
  };
}
