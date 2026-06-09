export type ProviderProtocol = "openai-responses" | "openai-chat-completions" | "anthropic-messages";

export interface ProviderApiErrorOptions {
  provider: ProviderProtocol;
  protocol: ProviderProtocol;
  status: number;
  message: string;
  type?: string;
  code?: string;
}

export class ProviderApiError extends Error {
  readonly provider: ProviderProtocol;
  readonly protocol: ProviderProtocol;
  readonly status: number;
  readonly type?: string;
  readonly code?: string;

  constructor(options: ProviderApiErrorOptions) {
    super(formatProviderErrorMessage(options));
    this.name = "ProviderApiError";
    this.provider = options.provider;
    this.protocol = options.protocol;
    this.status = options.status;
    this.type = options.type;
    this.code = options.code;
  }
}

export async function readProviderJson<T>(response: Response): Promise<{ payload?: T; rawText: string }> {
  const rawText = await response.text();
  if (!rawText.trim()) {
    return { rawText };
  }
  try {
    return { payload: JSON.parse(rawText) as T, rawText };
  } catch {
    return { rawText };
  }
}

export function createProviderApiError(input: {
  provider: ProviderProtocol;
  protocol?: ProviderProtocol;
  status: number;
  payload?: unknown;
  rawText?: string;
  fallbackMessage: string;
}): ProviderApiError {
  const extracted = extractProviderError(input.payload);
  return new ProviderApiError({
    provider: input.provider,
    protocol: input.protocol ?? input.provider,
    status: input.status,
    type: extracted.type,
    code: extracted.code,
    message: extracted.message ?? summarizeRawText(input.rawText) ?? input.fallbackMessage
  });
}

export function createInvalidProviderResponseError(provider: ProviderProtocol, message: string): ProviderApiError {
  return new ProviderApiError({
    provider,
    protocol: provider,
    status: 200,
    type: "invalid_provider_response",
    message
  });
}

function extractProviderError(payload: unknown): { message?: string; type?: string; code?: string } {
  if (typeof payload !== "object" || payload === null) {
    return {};
  }
  const error = (payload as { error?: unknown }).error;
  if (typeof error === "string") {
    const message = error.trim();
    return message ? { message } : {};
  }
  if (typeof error !== "object" || error === null) {
    const message = readStringField(payload, "message");
    return message ? { message } : {};
  }
  const raw = error as Record<string, unknown>;
  return {
    message: typeof raw.message === "string" && raw.message.trim() ? raw.message.trim() : undefined,
    type: typeof raw.type === "string" && raw.type.trim() ? raw.type.trim() : undefined,
    code: typeof raw.code === "string" && raw.code.trim() ? raw.code.trim() : undefined
  };
}

function readStringField(value: unknown, key: string): string | undefined {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  const field = (value as Record<string, unknown>)[key];
  return typeof field === "string" && field.trim() ? field.trim() : undefined;
}

function formatProviderErrorMessage(options: ProviderApiErrorOptions): string {
  const classifier = options.code ?? options.type;
  return `[${options.provider}] HTTP ${options.status}${classifier ? ` ${classifier}` : ""}: ${options.message}`;
}

function summarizeRawText(rawText: string | undefined): string | undefined {
  const text = rawText?.replace(/\s+/g, " ").trim();
  if (!text) {
    return undefined;
  }
  return text.length <= 300 ? text : `${text.slice(0, 297)}...`;
}
