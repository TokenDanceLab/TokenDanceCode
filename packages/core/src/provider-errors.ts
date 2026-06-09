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

export async function readProviderJson<T>(response: Response): Promise<{ payload?: T; rawText: string; malformed: boolean }> {
  const rawText = await response.text();
  if (!rawText.trim()) {
    return { rawText, malformed: false };
  }
  try {
    return { payload: JSON.parse(rawText) as T, rawText, malformed: false };
  } catch {
    return { rawText, malformed: true };
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

export function createMalformedProviderResponseError(provider: ProviderProtocol, rawText: string): ProviderApiError {
  return new ProviderApiError({
    provider,
    protocol: provider,
    status: 200,
    type: "malformed_provider_response",
    message: `Provider returned malformed JSON: ${summarizeRawText(rawText) ?? "<empty>"}`
  });
}

export function createProviderTransportError(provider: ProviderProtocol, error: unknown): ProviderApiError {
  const timeout = isAbortError(error);
  return new ProviderApiError({
    provider,
    protocol: provider,
    status: 0,
    type: timeout ? "provider_timeout" : "provider_transport_error",
    message: readErrorMessage(error) ?? (timeout ? "Provider request was aborted." : "Provider request failed before an HTTP response was received.")
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

function readErrorMessage(error: unknown): string | undefined {
  if (error instanceof Error && error.message.trim()) {
    return error.message.trim();
  }
  if (typeof error === "string" && error.trim()) {
    return error.trim();
  }
  return undefined;
}

function isAbortError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "name" in error && (error as { name?: unknown }).name === "AbortError";
}
