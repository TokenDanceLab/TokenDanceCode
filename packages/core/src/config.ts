import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { PermissionMode } from "./types.js";

export type ConfigProvider = "mock" | "openai-responses" | "anthropic-messages";

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

function sanitizeConfig(value: unknown): Partial<TokenDanceConfig> {
  if (typeof value !== "object" || value === null) {
    return {};
  }

  const raw = value as Record<string, unknown>;
  const config: Partial<TokenDanceConfig> = {};
  if (raw.provider === "mock" || raw.provider === "openai-responses" || raw.provider === "anthropic-messages") {
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
  return value === "mock" || value === "openai-responses" || value === "anthropic-messages" ? value : undefined;
}

function parsePermissionMode(value: string | undefined): PermissionMode | undefined {
  return value === "default" || value === "safe" || value === "auto" || value === "yolo" ? value : undefined;
}
