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
  kind: "defaults" | "global" | "project";
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
