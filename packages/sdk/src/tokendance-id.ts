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

function normalizeIssuerUrl(value: string): string {
  const parsed = new URL(requiredTrimmed(value, "TokenDanceID issuerUrl is required."));
  parsed.hash = "";
  parsed.search = "";
  return parsed.toString().replace(/\/$/, "");
}

function normalizeScope(value: string | string[] | undefined): string {
  if (Array.isArray(value)) {
    return value.map((scope) => scope.trim()).filter(Boolean).join(" ") || defaultScopes.join(" ");
  }
  return value?.trim() || defaultScopes.join(" ");
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
