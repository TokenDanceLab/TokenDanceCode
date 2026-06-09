import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { PermissionMode } from "./types.js";

export type ConfigProvider = "mock" | "openai-responses" | "openai-chat-completions" | "anthropic-messages";
export type ProviderApiKeyEnv = "OPENAI_API_KEY" | "ANTHROPIC_API_KEY" | "TOKENDANCE_GATEWAY_API_KEY";
export type ProviderBaseUrlEnv = "OPENAI_BASE_URL" | "ANTHROPIC_BASE_URL" | "TOKENDANCE_GATEWAY_BASE_URL";

export interface TokenDanceConfig {
  provider: ConfigProvider;
  model: string;
  permissionMode: PermissionMode;
}

export interface ConfigSource {
  kind: "defaults" | "global" | "project" | "env";
  path?: string;
}

export interface ConfigInfo {
  config: TokenDanceConfig;
  sources: ConfigSource[];
  globalConfigPath: string;
  projectConfigPath: string;
}

export interface ConfigReadOptions {
  projectRoot: string;
  homeDir?: string;
  env?: Record<string, string | undefined>;
}

export interface ProviderRuntimeEnv {
  apiKey?: string;
  apiKeyEnv?: ProviderApiKeyEnv;
  baseUrl?: string;
  baseUrlEnv?: ProviderBaseUrlEnv;
}

export interface ProviderIntegrationGate {
  enabled: boolean;
  missing: string[];
}

const defaultConfig: TokenDanceConfig = {
  provider: "mock",
  model: "mock",
  permissionMode: "default"
};

export async function readTokenDanceConfig(options: ConfigReadOptions): Promise<ConfigInfo> {
  const homeDir = options.homeDir ?? process.env.USERPROFILE ?? process.env.HOME ?? options.projectRoot;
  const globalConfigPath = join(homeDir, ".tokendance", "config.json");
  const projectConfigPath = join(options.projectRoot, ".tokendance", "config.json");
  const sources: ConfigSource[] = [{ kind: "defaults" }];
  let config = { ...defaultConfig };

  const globalConfig = await readPartialConfig(globalConfigPath);
  if (globalConfig) {
    config = { ...config, ...globalConfig };
    sources.push({ kind: "global", path: globalConfigPath });
  }

  const projectConfig = await readPartialConfig(projectConfigPath);
  if (projectConfig) {
    config = { ...config, ...projectConfig };
    sources.push({ kind: "project", path: projectConfigPath });
  }

  const envConfig = readEnvConfig(options.env);
  if (envConfig) {
    config = { ...config, ...envConfig };
    sources.push({ kind: "env" });
  }

  return {
    config,
    sources,
    globalConfigPath,
    projectConfigPath
  };
}

async function readPartialConfig(path: string): Promise<Partial<TokenDanceConfig> | undefined> {
  try {
    return sanitizeConfig(JSON.parse(await readFile(path, "utf8")));
  } catch {
    return undefined;
  }
}

function readEnvConfig(env: Record<string, string | undefined> | undefined): Partial<TokenDanceConfig> | undefined {
  if (!env) {
    return undefined;
  }

  const config: Partial<TokenDanceConfig> = {};
  const provider = parseProvider(env.TOKENDANCE_PROVIDER);
  const model = env.TOKENDANCE_MODEL?.trim() || env.MODEL_ID?.trim();
  const permissionMode = parsePermissionMode(env.TOKENDANCE_PERMISSION_MODE);

  if (provider) {
    config.provider = provider;
  } else if (model && env.TOKENDANCE_GATEWAY_API_KEY) {
    config.provider = "openai-chat-completions";
  } else if (model && env.ANTHROPIC_API_KEY) {
    config.provider = "anthropic-messages";
  } else if (model && env.OPENAI_API_KEY) {
    config.provider = "openai-responses";
  }

  if (model) {
    config.model = model;
  }
  if (permissionMode) {
    config.permissionMode = permissionMode;
  }

  return Object.keys(config).length > 0 ? config : undefined;
}

export function resolveProviderRuntimeEnv(provider: ConfigProvider, env: Record<string, string | undefined> = process.env): ProviderRuntimeEnv {
  if (provider === "openai-chat-completions") {
    return {
      ...firstPresent([
        ["TOKENDANCE_GATEWAY_API_KEY", env.TOKENDANCE_GATEWAY_API_KEY],
        ["OPENAI_API_KEY", env.OPENAI_API_KEY]
      ]),
      ...firstPresentBaseUrl([
        ["TOKENDANCE_GATEWAY_BASE_URL", env.TOKENDANCE_GATEWAY_BASE_URL],
        ["OPENAI_BASE_URL", env.OPENAI_BASE_URL]
      ])
    };
  }

  if (provider === "openai-responses") {
    return {
      ...firstPresent([["OPENAI_API_KEY", env.OPENAI_API_KEY]]),
      ...firstPresentBaseUrl([["OPENAI_BASE_URL", env.OPENAI_BASE_URL]])
    };
  }

  if (provider === "anthropic-messages") {
    return {
      ...firstPresent([["ANTHROPIC_API_KEY", env.ANTHROPIC_API_KEY]]),
      ...firstPresentBaseUrl([["ANTHROPIC_BASE_URL", env.ANTHROPIC_BASE_URL]])
    };
  }

  return {};
}

export function shouldRunProviderIntegration(provider: ConfigProvider, env: Record<string, string | undefined> = process.env): ProviderIntegrationGate {
  if (provider === "mock") {
    return { enabled: false, missing: ["real provider"] };
  }

  const missing: string[] = [];
  if (env.TOKENDANCE_RUN_MODEL_INTEGRATION !== "1") {
    missing.push("TOKENDANCE_RUN_MODEL_INTEGRATION=1");
  }

  const runtimeEnv = resolveProviderRuntimeEnv(provider, env);
  const modelEnv = integrationModelEnv(provider);
  if (!runtimeEnv.apiKey) {
    missing.push(provider === "openai-chat-completions" ? "TOKENDANCE_GATEWAY_API_KEY or OPENAI_API_KEY" : requiredApiKeyEnv(provider));
  }
  if (!envValue(env[modelEnv])) {
    missing.push(modelEnv);
  }

  return {
    enabled: missing.length === 0,
    missing
  };
}

function sanitizeConfig(value: unknown): Partial<TokenDanceConfig> {
  if (typeof value !== "object" || value === null) {
    return {};
  }

  const raw = value as Record<string, unknown>;
  const config: Partial<TokenDanceConfig> = {};
  if (isConfigProvider(raw.provider)) {
    config.provider = raw.provider;
  }
  if (typeof raw.model === "string" && raw.model.trim()) {
    config.model = raw.model.trim();
  }
  if (raw.permissionMode === "default" || raw.permissionMode === "safe" || raw.permissionMode === "auto" || raw.permissionMode === "yolo") {
    config.permissionMode = raw.permissionMode;
  }
  return config;
}

function parseProvider(value: string | undefined): ConfigProvider | undefined {
  return isConfigProvider(value) ? value : undefined;
}

function isConfigProvider(value: unknown): value is ConfigProvider {
  return value === "mock" || value === "openai-responses" || value === "openai-chat-completions" || value === "anthropic-messages";
}

function parsePermissionMode(value: string | undefined): PermissionMode | undefined {
  return value === "default" || value === "safe" || value === "auto" || value === "yolo" ? value : undefined;
}

function firstPresent(candidates: Array<[ProviderApiKeyEnv, string | undefined]>): Pick<ProviderRuntimeEnv, "apiKey" | "apiKeyEnv"> {
  for (const [apiKeyEnv, value] of candidates) {
    const apiKey = envValue(value);
    if (apiKey) {
      return { apiKey, apiKeyEnv };
    }
  }
  return {};
}

function firstPresentBaseUrl(candidates: Array<[ProviderBaseUrlEnv, string | undefined]>): Pick<ProviderRuntimeEnv, "baseUrl" | "baseUrlEnv"> {
  for (const [baseUrlEnv, value] of candidates) {
    const baseUrl = envValue(value);
    if (baseUrl) {
      return { baseUrl, baseUrlEnv };
    }
  }
  return {};
}

function envValue(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed || undefined;
}

function requiredApiKeyEnv(provider: Exclude<ConfigProvider, "mock" | "openai-chat-completions">): ProviderApiKeyEnv {
  return provider === "openai-responses" ? "OPENAI_API_KEY" : "ANTHROPIC_API_KEY";
}

function integrationModelEnv(provider: Exclude<ConfigProvider, "mock">): string {
  if (provider === "openai-responses") {
    return "TOKENDANCE_OPENAI_RESPONSES_TEST_MODEL";
  }
  if (provider === "openai-chat-completions") {
    return "TOKENDANCE_OPENAI_CHAT_TEST_MODEL";
  }
  return "TOKENDANCE_ANTHROPIC_TEST_MODEL";
}
