import { createHash, randomBytes } from "node:crypto";

const defaultIssuerUrl = "https://id.vectorcontrol.tech";
const defaultScopes = ["openid", "profile", "email"] as const;
const reservedExtraParams = new Set(["response_type", "client_id", "redirect_uri", "scope", "state", "nonce", "code_challenge", "code_challenge_method"]);

export interface TokenDanceIdLoginOptions {
  issuerUrl?: string;
  clientId: string;
  redirectUri: string;
  scope?: string | string[];
  state?: string;
  nonce?: string;
  codeVerifier?: string;
  extraParams?: Record<string, string | undefined>;
}

export interface TokenDanceIdLoginRequest {
  issuerUrl: string;
  authorizeEndpoint: string;
  authorizationUrl: string;
  clientId: string;
  redirectUri: string;
  scope: string;
  state: string;
  nonce: string;
  codeVerifier: string;
  codeChallenge: string;
  codeChallengeMethod: "S256";
}

export interface TokenDanceIdCallbackResult {
  code: string;
  state: string;
  codeVerifier: string;
  redirectUri: string;
  issuerUrl: string;
}

export interface TokenDanceIdOidcBoundaries {
  exchangesAuthorizationCode: false;
  storesTokenDanceIdTokens: false;
  acceptsGatewayApiKey: false;
  exchangeOwner: "AgentHub Hub Server";
  jwksOwner: "AgentHub Hub Server";
  sessionOwner: "AgentHub Hub Server";
}

export interface TokenDanceIdLoginDiagnostic {
  ok: boolean;
  pkce: {
    ok: boolean;
    method: TokenDanceIdLoginRequest["codeChallengeMethod"];
    codeVerifierLength: number;
    codeChallengeLength: number;
  };
  state: {
    ok: boolean;
    present: boolean;
    length: number;
  };
  callback: TokenDanceIdCallbackOwnershipDiagnostic;
  boundaries: TokenDanceIdOidcBoundaries;
}

export type TokenDanceIdCallbackDiagnosticReason =
  | "ready_for_hub_exchange"
  | "provider_error"
  | "missing_code"
  | "missing_state"
  | "state_mismatch"
  | "invalid_callback";

export interface TokenDanceIdCallbackDiagnostic {
  ok: boolean;
  reason: TokenDanceIdCallbackDiagnosticReason;
  message: string;
  code: {
    present: boolean;
  };
  state: {
    present: boolean;
    matches?: boolean;
    expectedLength: number;
    receivedLength: number;
  };
  providerError?: {
    error: string;
    description?: string;
  };
  callback: TokenDanceIdCallbackOwnershipDiagnostic;
  boundaries: TokenDanceIdOidcBoundaries;
}

export interface TokenDanceIdCallbackOwnershipDiagnostic {
  issuerUrl: string;
  redirectUri: string;
  exchangeOwner: "AgentHub Hub Server";
  jwksOwner: "AgentHub Hub Server";
  sessionOwner: "AgentHub Hub Server";
}

export function createTokenDanceIdLoginRequest(options: TokenDanceIdLoginOptions): TokenDanceIdLoginRequest {
  const issuerUrl = normalizeIssuerUrl(options.issuerUrl ?? defaultIssuerUrl);
  const authorizeEndpoint = `${issuerUrl}/oidc/authorize`;
  const clientId = requiredTrimmed(options.clientId, "TokenDanceID clientId is required.");
  const redirectUri = requiredTrimmed(options.redirectUri, "TokenDanceID redirectUri is required.");
  const scope = normalizeScope(options.scope);
  const state = options.state?.trim() || randomToken();
  const nonce = options.nonce?.trim() || randomToken();
  const codeVerifier = options.codeVerifier?.trim() || randomToken(48);
  const codeChallenge = createHash("sha256").update(codeVerifier).digest("base64url");
  const url = new URL(authorizeEndpoint);

  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("scope", scope);
  url.searchParams.set("state", state);
  url.searchParams.set("nonce", nonce);
  url.searchParams.set("code_challenge", codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");

  for (const [key, value] of Object.entries(options.extraParams ?? {})) {
    if (!value || reservedExtraParams.has(key)) {
      continue;
    }
    url.searchParams.set(key, value);
  }

  return {
    issuerUrl,
    authorizeEndpoint,
    authorizationUrl: url.toString(),
    clientId,
    redirectUri,
    scope,
    state,
    nonce,
    codeVerifier,
    codeChallenge,
    codeChallengeMethod: "S256"
  };
}

export function diagnoseTokenDanceIdLoginRequest(request: TokenDanceIdLoginRequest): TokenDanceIdLoginDiagnostic {
  const pkceOk = request.codeChallengeMethod === "S256" && request.codeVerifier.length > 0 && request.codeChallenge.length > 0;
  const statePresent = request.state.trim().length > 0;
  return {
    ok: pkceOk && statePresent,
    pkce: {
      ok: pkceOk,
      method: request.codeChallengeMethod,
      codeVerifierLength: request.codeVerifier.length,
      codeChallengeLength: request.codeChallenge.length
    },
    state: {
      ok: statePresent,
      present: statePresent,
      length: request.state.length
    },
    callback: callbackOwnership(request),
    boundaries: oidcBoundaries()
  };
}

export function diagnoseTokenDanceIdCallback(callbackUrl: string | URL | URLSearchParams, request: TokenDanceIdLoginRequest): TokenDanceIdCallbackDiagnostic {
  let params: URLSearchParams;
  try {
    params = callbackParams(callbackUrl);
  } catch (error) {
    return callbackDiagnostic("invalid_callback", "TokenDanceID callback URL is invalid.", request, "", "", undefined);
  }

  const providerError = params.get("error")?.trim();
  const providerErrorDescription = params.get("error_description")?.trim() || undefined;
  const code = params.get("code")?.trim() ?? "";
  const state = params.get("state")?.trim() ?? "";
  if (providerError) {
    return callbackDiagnostic(
      "provider_error",
      `TokenDanceID callback returned ${providerError}${providerErrorDescription ? `: ${providerErrorDescription}` : ""}`,
      request,
      code,
      state,
      {
        error: providerError,
        description: providerErrorDescription
      }
    );
  }
  if (!code) {
    return callbackDiagnostic("missing_code", "TokenDanceID callback is missing code.", request, code, state, undefined);
  }
  if (!state) {
    return callbackDiagnostic("missing_state", "TokenDanceID callback is missing state.", request, code, state, undefined);
  }
  if (state !== request.state) {
    return callbackDiagnostic("state_mismatch", "TokenDanceID callback state mismatch.", request, code, state, undefined);
  }
  return callbackDiagnostic("ready_for_hub_exchange", "Callback code and state are ready for AgentHub Hub Server exchange.", request, code, state, undefined);
}

export function verifyTokenDanceIdCallback(callbackUrl: string | URL | URLSearchParams, request: TokenDanceIdLoginRequest): TokenDanceIdCallbackResult {
  const params = callbackParams(callbackUrl);
  const error = params.get("error");
  if (error) {
    const description = params.get("error_description");
    throw new Error(`TokenDanceID callback returned ${error}${description ? `: ${description}` : ""}`);
  }

  const code = params.get("code")?.trim();
  const state = params.get("state")?.trim();
  if (!code || !state) {
    throw new Error("TokenDanceID callback requires code and state.");
  }

  if (state !== request.state) {
    throw new Error("TokenDanceID callback state mismatch.");
  }

  return {
    code,
    state,
    codeVerifier: request.codeVerifier,
    redirectUri: request.redirectUri,
    issuerUrl: request.issuerUrl
  };
}

function callbackDiagnostic(
  reason: TokenDanceIdCallbackDiagnosticReason,
  message: string,
  request: TokenDanceIdLoginRequest,
  code: string,
  state: string,
  providerError: TokenDanceIdCallbackDiagnostic["providerError"]
): TokenDanceIdCallbackDiagnostic {
  return {
    ok: reason === "ready_for_hub_exchange",
    reason,
    message,
    code: {
      present: code.length > 0
    },
    state: {
      present: state.length > 0,
      matches: state.length > 0 ? state === request.state : undefined,
      expectedLength: request.state.length,
      receivedLength: state.length
    },
    providerError,
    callback: callbackOwnership(request),
    boundaries: oidcBoundaries()
  };
}

function callbackOwnership(request: TokenDanceIdLoginRequest): TokenDanceIdCallbackOwnershipDiagnostic {
  return {
    issuerUrl: request.issuerUrl,
    redirectUri: request.redirectUri,
    exchangeOwner: "AgentHub Hub Server",
    jwksOwner: "AgentHub Hub Server",
    sessionOwner: "AgentHub Hub Server"
  };
}

function oidcBoundaries(): TokenDanceIdOidcBoundaries {
  return {
    exchangesAuthorizationCode: false,
    storesTokenDanceIdTokens: false,
    acceptsGatewayApiKey: false,
    exchangeOwner: "AgentHub Hub Server",
    jwksOwner: "AgentHub Hub Server",
    sessionOwner: "AgentHub Hub Server"
  };
}

function normalizeIssuerUrl(value: string): string {
  const parsed = new URL(requiredTrimmed(value, "TokenDanceID issuerUrl is required."));
  parsed.hash = "";
  parsed.search = "";
  return parsed.toString().replace(/\/$/, "");
}

function normalizeScope(value: string | string[] | undefined): string {
  const scope = Array.isArray(value)
    ? value.map((item) => item.trim()).filter(Boolean).join(" ")
    : value?.trim();
  const normalized = scope || defaultScopes.join(" ");
  if (!normalized.split(/\s+/).includes("openid")) {
    throw new Error("TokenDanceID OIDC scope must include openid.");
  }
  return normalized;
}

function requiredTrimmed(value: string, message: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error(message);
  }
  return trimmed;
}

function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

function callbackParams(callbackUrl: string | URL | URLSearchParams): URLSearchParams {
  if (callbackUrl instanceof URLSearchParams) {
    return callbackUrl;
  }
  if (callbackUrl instanceof URL) {
    return callbackUrl.searchParams;
  }
  return new URL(callbackUrl).searchParams;
}
