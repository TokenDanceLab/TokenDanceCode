import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
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

export type ConfigWriteScope = "project" | "global";

export type ConfigPatch = Partial<TokenDanceConfig>;

export interface ConfigWriteOptions extends ConfigReadOptions {
  scope?: ConfigWriteScope;
  config: ConfigPatch;
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

export interface ProviderSmokePreflight extends ProviderIntegrationGate {
  provider: ConfigProvider;
  status: "ready" | "skip";
  message: string;
  requiredApiKeyEnvs: ProviderApiKeyEnv[];
  apiKeyEnv?: ProviderApiKeyEnv;
  baseUrl?: string;
  baseUrlEnv?: ProviderBaseUrlEnv;
  modelEnv?: string;
  model?: string;
}

export interface ProviderConfigValidation {
  ready: boolean;
  provider: ConfigProvider;
  model: string;
  missing: string[];
  credentials:
    | { apiKey: "not-required" }
    | { apiKey: "present"; apiKeyEnv: ProviderApiKeyEnv; required: ProviderApiKeyEnv[] }
    | { apiKey: "missing"; required: ProviderApiKeyEnv[] };
  baseUrl:
    | { status: "not-required" }
    | { status: "present"; baseUrlEnv: ProviderBaseUrlEnv }
    | { status: "default"; defaultUrl: string };
}

const defaultConfig: TokenDanceConfig = {
  provider: "mock",
  model: "mock",
  permissionMode: "default"
};
const tokendanceGatewayDefaultBaseUrl = "https://api.vectorcontrol.tech/v1";
const openaiDefaultBaseUrl = "https://api.openai.com/v1";
const realProviderSmokeOptInEnv = "TOKENDANCE_RUN_REAL_PROVIDER_SMOKE";

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

export async function writeTokenDanceConfig(options: ConfigWriteOptions): Promise<ConfigInfo> {
  const homeDir = options.homeDir ?? process.env.USERPROFILE ?? process.env.HOME ?? options.projectRoot;
  const targetPath = options.scope === "global" ? join(homeDir, ".tokendance", "config.json") : join(options.projectRoot, ".tokendance", "config.json");
  const current = (await readPartialConfig(targetPath)) ?? {};
  const next = sanitizeConfig({ ...current, ...sanitizeConfig(options.config) });

  await mkdir(dirname(targetPath), { recursive: true });
  await writeFile(targetPath, `${JSON.stringify(next, null, 2)}\n`, "utf8");

  return readTokenDanceConfig(options);
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
  } else if (model && envValue(env.TOKENDANCE_GATEWAY_API_KEY)) {
    config.provider = "openai-chat-completions";
  } else if (model && envValue(env.ANTHROPIC_API_KEY)) {
    config.provider = "anthropic-messages";
  } else if (model && envValue(env.OPENAI_API_KEY)) {
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
    const gatewayApiKey = envValue(env.TOKENDANCE_GATEWAY_API_KEY);
    if (gatewayApiKey) {
      const gatewayBaseUrl = envValue(env.TOKENDANCE_GATEWAY_BASE_URL);
      return {
        apiKey: gatewayApiKey,
        apiKeyEnv: "TOKENDANCE_GATEWAY_API_KEY",
        ...(gatewayBaseUrl ? { baseUrl: gatewayBaseUrl, baseUrlEnv: "TOKENDANCE_GATEWAY_BASE_URL" as const } : { baseUrl: tokendanceGatewayDefaultBaseUrl })
      };
    }

    const openaiApiKey = envValue(env.OPENAI_API_KEY);
    if (openaiApiKey) {
      return {
        apiKey: openaiApiKey,
        apiKeyEnv: "OPENAI_API_KEY",
        ...firstPresentBaseUrl([["OPENAI_BASE_URL", env.OPENAI_BASE_URL]])
      };
    }

    const gatewayBaseUrl = firstPresentBaseUrl([["TOKENDANCE_GATEWAY_BASE_URL", env.TOKENDANCE_GATEWAY_BASE_URL]]);
    return gatewayBaseUrl.baseUrl ? gatewayBaseUrl : { baseUrl: tokendanceGatewayDefaultBaseUrl };
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
  const preflight = preflightProviderSmoke(provider, env);
  return {
    enabled: preflight.enabled,
    missing: preflight.missing
  };
}

export function preflightProviderSmoke(provider: ConfigProvider, env: Record<string, string | undefined> = process.env): ProviderSmokePreflight {
  if (provider === "mock") {
    return {
      provider,
      status: "skip",
      enabled: false,
      missing: ["real provider"],
      message: "Skipping mock real provider smoke; choose openai-responses, openai-chat-completions, or anthropic-messages.",
      requiredApiKeyEnvs: []
    };
  }

  const missing: string[] = [];
  if (env[realProviderSmokeOptInEnv] !== "1") {
    missing.push(`${realProviderSmokeOptInEnv}=1`);
  }

  const runtimeEnv = resolveProviderRuntimeEnv(provider, env);
  const modelEnv = integrationModelEnv(provider);
  if (!runtimeEnv.apiKey) {
    missing.push(apiKeyMissingLabel(provider));
  }
  const model = envValue(env[modelEnv]);
  if (!model) {
    missing.push(modelEnv);
  }
  const enabled = missing.length === 0;

  return {
    provider,
    status: enabled ? "ready" : "skip",
    enabled,
    missing,
    message: enabled ? readyProviderSmokeMessage(provider, runtimeEnv.apiKeyEnv, modelEnv) : skipProviderSmokeMessage(provider, missing),
    requiredApiKeyEnvs: requiredRuntimeApiKeyEnvs(provider),
    apiKeyEnv: runtimeEnv.apiKeyEnv,
    baseUrlEnv: runtimeEnv.baseUrlEnv,
    baseUrl: runtimeEnv.baseUrl ?? defaultBaseUrl(provider, runtimeEnv.apiKeyEnv),
    modelEnv,
    model
  };
}

export function validateProviderConfig(config: TokenDanceConfig, env: Record<string, string | undefined> = process.env): ProviderConfigValidation {
  if (config.provider === "mock") {
    return {
      ready: true,
      provider: config.provider,
      model: config.model,
      missing: [],
      credentials: { apiKey: "not-required" },
      baseUrl: { status: "not-required" }
    };
  }

  const runtimeEnv = resolveProviderRuntimeEnv(config.provider, env);
  const required = requiredRuntimeApiKeyEnvs(config.provider);
  const missing: string[] = [];
  if (!runtimeEnv.apiKey || !runtimeEnv.apiKeyEnv) {
    missing.push(config.provider === "openai-chat-completions" ? "TOKENDANCE_GATEWAY_API_KEY or OPENAI_API_KEY" : required[0]!);
  }
  if (config.model.trim() === "" || config.model === defaultConfig.model) {
    missing.push("model");
  }

  return {
    ready: missing.length === 0,
    provider: config.provider,
    model: config.model,
    missing,
    credentials: runtimeEnv.apiKeyEnv
      ? { apiKey: "present", apiKeyEnv: runtimeEnv.apiKeyEnv, required }
      : { apiKey: "missing", required },
    baseUrl: runtimeEnv.baseUrlEnv
      ? { status: "present", baseUrlEnv: runtimeEnv.baseUrlEnv }
      : { status: "default", defaultUrl: defaultBaseUrl(config.provider, runtimeEnv.apiKeyEnv) }
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

function requiredRuntimeApiKeyEnvs(provider: Exclude<ConfigProvider, "mock">): ProviderApiKeyEnv[] {
  if (provider === "openai-chat-completions") {
    return ["TOKENDANCE_GATEWAY_API_KEY", "OPENAI_API_KEY"];
  }
  return [requiredApiKeyEnv(provider)];
}

function apiKeyMissingLabel(provider: Exclude<ConfigProvider, "mock">): string {
  return provider === "openai-chat-completions" ? "TOKENDANCE_GATEWAY_API_KEY or OPENAI_API_KEY" : requiredApiKeyEnv(provider);
}

function defaultBaseUrl(provider: Exclude<ConfigProvider, "mock">, apiKeyEnv?: ProviderApiKeyEnv): string {
  if (provider === "anthropic-messages") {
    return "https://api.anthropic.com";
  }
  if (provider === "openai-chat-completions" && apiKeyEnv !== "OPENAI_API_KEY") {
    return tokendanceGatewayDefaultBaseUrl;
  }
  return openaiDefaultBaseUrl;
}

function readyProviderSmokeMessage(provider: Exclude<ConfigProvider, "mock">, apiKeyEnv: ProviderApiKeyEnv | undefined, modelEnv: string): string {
  const label = provider === "openai-chat-completions" && apiKeyEnv === "TOKENDANCE_GATEWAY_API_KEY" ? "TokenDance Gateway smoke" : `${provider} real provider smoke`;
  return `${label} is explicitly enabled for ${provider} using ${apiKeyEnv ?? apiKeyMissingLabel(provider)} and ${modelEnv}.`;
}

function skipProviderSmokeMessage(provider: Exclude<ConfigProvider, "mock">, missing: string[]): string {
  const hint = `Skipping ${provider} real provider smoke; set ${missing.join(", ")} in a controlled shell or global ~/.tokendance/.env to opt in.`;
  if (provider === "openai-chat-completions" && missing.includes("TOKENDANCE_GATEWAY_API_KEY or OPENAI_API_KEY")) {
    return `${hint} TokenDance Gateway smoke requires a TokenDance API key, not a TokenDanceID/OIDC token.`;
  }
  return hint;
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
