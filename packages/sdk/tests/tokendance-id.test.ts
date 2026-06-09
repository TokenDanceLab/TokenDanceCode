import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createTokenDanceIdLoginRequest, diagnoseTokenDanceIdCallback, diagnoseTokenDanceIdLoginRequest, verifyTokenDanceIdCallback } from "../src/index.js";

describe("TokenDanceID OIDC helpers", () => {
  it("creates an Authorization Code + PKCE login URL for AgentHub callers", () => {
    const login = createTokenDanceIdLoginRequest({
      clientId: "agenthub-local",
      redirectUri: "http://127.0.0.1:48731/callback",
      codeVerifier: "verifier-for-test",
      state: "state-for-test",
      nonce: "nonce-for-test",
      extraParams: {
        device_type: "desktop",
        device_id: "00000000-0000-4000-8000-000000000001"
      }
    });

    const url = new URL(login.authorizationUrl);

    expect(login.issuerUrl).toBe("https://id.vectorcontrol.tech");
    expect(login.authorizeEndpoint).toBe("https://id.vectorcontrol.tech/oidc/authorize");
    expect(login.codeChallengeMethod).toBe("S256");
    expect(login.codeChallenge).toBe(base64UrlSha256("verifier-for-test"));
    expect(url.origin).toBe("https://id.vectorcontrol.tech");
    expect(url.pathname).toBe("/oidc/authorize");
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("client_id")).toBe("agenthub-local");
    expect(url.searchParams.get("redirect_uri")).toBe("http://127.0.0.1:48731/callback");
    expect(url.searchParams.get("scope")).toBe("openid profile email");
    expect(url.searchParams.get("state")).toBe("state-for-test");
    expect(url.searchParams.get("nonce")).toBe("nonce-for-test");
    expect(url.searchParams.get("code_challenge")).toBe(base64UrlSha256("verifier-for-test"));
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("device_type")).toBe("desktop");
    expect(url.searchParams.get("device_id")).toBe("00000000-0000-4000-8000-000000000001");
  });

  it("requires custom TokenDanceID scopes to keep openid", () => {
    const withStringScope = createTokenDanceIdLoginRequest({
      clientId: "agenthub-local",
      redirectUri: "http://127.0.0.1:48731/callback",
      scope: "openid profile"
    });
    const withArrayScope = createTokenDanceIdLoginRequest({
      clientId: "agenthub-local",
      redirectUri: "http://127.0.0.1:48731/callback",
      scope: ["openid", "email"]
    });

    expect(new URL(withStringScope.authorizationUrl).searchParams.get("scope")).toBe("openid profile");
    expect(new URL(withArrayScope.authorizationUrl).searchParams.get("scope")).toBe("openid email");
    expect(() => createTokenDanceIdLoginRequest({
      clientId: "agenthub-local",
      redirectUri: "http://127.0.0.1:48731/callback",
      scope: "profile email"
    })).toThrow("TokenDanceID OIDC scope must include openid.");
    expect(() => createTokenDanceIdLoginRequest({
      clientId: "agenthub-local",
      redirectUri: "http://127.0.0.1:48731/callback",
      scope: ["profile", "email"]
    })).toThrow("TokenDanceID OIDC scope must include openid.");
  });

  it("verifies callback state and returns the code verifier for backend exchange", () => {
    const login = createTokenDanceIdLoginRequest({
      clientId: "agenthub-local",
      redirectUri: "http://127.0.0.1:48731/callback",
      codeVerifier: "verifier-for-test",
      state: "state-for-test",
      nonce: "nonce-for-test"
    });

    const callback = verifyTokenDanceIdCallback("http://127.0.0.1:48731/callback?code=auth-code&state=state-for-test", login);

    expect(callback).toEqual({
      code: "auth-code",
      state: "state-for-test",
      codeVerifier: "verifier-for-test",
      redirectUri: "http://127.0.0.1:48731/callback",
      issuerUrl: "https://id.vectorcontrol.tech"
    });
  });

  it("reports PKCE, state, callback, and ownership diagnostics without exchanging or storing tokens", () => {
    const login = createTokenDanceIdLoginRequest({
      clientId: "agenthub-local",
      redirectUri: "http://127.0.0.1:48731/callback",
      codeVerifier: "verifier-for-test",
      state: "state-for-test",
      nonce: "nonce-for-test"
    });

    const loginDiagnostic = diagnoseTokenDanceIdLoginRequest(login);
    const readyCallback = diagnoseTokenDanceIdCallback("http://127.0.0.1:48731/callback?code=auth-code&state=state-for-test", login);
    const mismatchCallback = diagnoseTokenDanceIdCallback("http://127.0.0.1:48731/callback?code=auth-code&state=wrong", login);

    expect(loginDiagnostic).toMatchObject({
      ok: true,
      pkce: {
        ok: true,
        method: "S256",
        codeVerifierLength: "verifier-for-test".length,
        codeChallengeLength: base64UrlSha256("verifier-for-test").length
      },
      state: {
        ok: true,
        present: true,
        length: "state-for-test".length
      },
      callback: {
        exchangeOwner: "AgentHub Hub Server",
        jwksOwner: "AgentHub Hub Server",
        sessionOwner: "AgentHub Hub Server"
      },
      boundaries: {
        exchangesAuthorizationCode: false,
        storesTokenDanceIdTokens: false,
        acceptsGatewayApiKey: false
      }
    });
    expect(readyCallback).toMatchObject({
      ok: true,
      reason: "ready_for_hub_exchange",
      code: { present: true },
      state: { present: true, matches: true },
      callback: {
        exchangeOwner: "AgentHub Hub Server",
        jwksOwner: "AgentHub Hub Server",
        sessionOwner: "AgentHub Hub Server"
      },
      boundaries: {
        exchangesAuthorizationCode: false,
        storesTokenDanceIdTokens: false,
        acceptsGatewayApiKey: false
      }
    });
    expect(mismatchCallback).toMatchObject({
      ok: false,
      reason: "state_mismatch",
      code: { present: true },
      state: { present: true, matches: false }
    });
    expect(readyCallback).not.toHaveProperty("accessToken");
    expect(readyCallback).not.toHaveProperty("refreshToken");
  });

  it("rejects callback errors and state mismatches", () => {
    const login = createTokenDanceIdLoginRequest({
      clientId: "agenthub-local",
      redirectUri: "http://127.0.0.1:48731/callback",
      codeVerifier: "verifier-for-test",
      state: "state-for-test",
      nonce: "nonce-for-test"
    });

    expect(() => verifyTokenDanceIdCallback("http://127.0.0.1:48731/callback?error=access_denied&error_description=Denied&state=state-for-test", login)).toThrow(
      "TokenDanceID callback returned access_denied: Denied"
    );
    expect(() => verifyTokenDanceIdCallback("http://127.0.0.1:48731/callback?code=auth-code&state=wrong", login)).toThrow(
      "TokenDanceID callback state mismatch."
    );
  });
});

function base64UrlSha256(value: string): string {
  return createHash("sha256").update(value).digest("base64url");
}
