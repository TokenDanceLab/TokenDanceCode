/**
 * Config, gateway, and auth CLI commands.
 */
import { join } from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import {
  TokenDanceCode,
  createTokenDanceIdLoginRequest,
  diagnoseTokenDanceIdLoginRequest,
  type ConfigPatch,
  type ConfigWriteScope,
  type PermissionMode
} from "@tokendance/code-sdk";
import { heading, label, styleFromEnv, type CliStyle } from "./format.js";
import { write, readCliEnv, homeDirFor, type CliIO } from "./cli-io.js";

const permissionModes = new Set<PermissionMode>(["default", "safe", "auto", "yolo"]);
const configProviders = new Set(["mock", "openai-responses", "openai-chat-completions", "anthropic-messages"]);

export async function configCommand(args: string[], io: CliIO): Promise<number> {
  const env = await readCliEnv(io);
  const style = styleFromEnv(env);
  const client = new TokenDanceCode({ env });
  if (args[0] === "validate") {
    const format = configFormat(args.slice(1));
    if (stripConfigFormatArgs(args.slice(1)).length > 0) {
      await write(io.stderr, "Usage: tokendance config validate [--json]\n");
      return 1;
    }

    const info = await client.validateConfig({ projectRoot: io.cwd(), homeDir: homeDirFor(io) });
    if (format === "json") {
      await write(io.stdout, `${JSON.stringify(info, null, 2)}\n`);
    } else {
      await printConfigValidation(io, info.validation);
    }
    return info.validation.ready ? 0 : 1;
  }

  if (args[0] === "set") {
    const format = configFormat(args.slice(1));
    const parsed = parseConfigSetArgs(stripConfigFormatArgs(args.slice(1)));
    if ("error" in parsed) {
      await write(io.stderr, `${parsed.error}\n`);
      await write(io.stderr, configSetUsage());
      return 1;
    }

    const info = await client.setConfig(parsed.config, { projectRoot: io.cwd(), homeDir: homeDirFor(io), scope: parsed.scope });
    const savedPath = parsed.scope === "global" ? info.globalConfigPath : info.projectConfigPath;
    if (format === "json") {
      await write(io.stdout, `${JSON.stringify({ ...info, scope: parsed.scope, savedPath }, null, 2)}\n`);
      return 0;
    }
    await write(io.stdout, `Saved ${parsed.scope} config in ${savedPath}\n`);
    await writeField(io, "provider", info.config.provider);
    await writeField(io, "model", info.config.model);
    await writeField(io, "permissionMode", info.config.permissionMode);
    return 0;
  }

  const format = configFormat(args);
  if (stripConfigFormatArgs(args).length > 0) {
    await write(io.stderr, "Usage: tokendance config [--json] [validate [--json] | set [--json] [--project|--global] provider <provider> model <model> permission-mode <mode>]\n");
    return 1;
  }

  const info = await client.config({ projectRoot: io.cwd(), homeDir: homeDirFor(io) });
  if (format === "json") {
    await write(io.stdout, `${JSON.stringify(info, null, 2)}\n`);
    return 0;
  }
  await writeSection(io, "Configuration", style);
  await writeField(io, "provider", info.config.provider);
  await writeField(io, "model", info.config.model);
  await writeField(io, "permissionMode", info.config.permissionMode);
  await writeSection(io, "Paths", style);
  await writeField(io, "globalConfig", info.globalConfigPath);
  await writeField(io, "projectConfig", info.projectConfigPath);
  await writeSection(io, "Sources", style);
  for (const source of info.sources) {
    await write(io.stdout, `source: ${source.kind}${source.path ? ` ${source.path}` : ""}\n`);
  }
  return 0;
}

async function printConfigValidation(io: CliIO, validation: Awaited<ReturnType<TokenDanceCode["validateConfig"]>>["validation"]): Promise<void> {
  const style = styleFromEnv(await readCliEnv(io));
  await writeSection(io, "Config Validation", style);
  await writeField(io, "ready", yesNo(validation.ready));
  await writeField(io, "provider", validation.provider);
  await writeField(io, "model", validation.model);
  await writeField(io, "missing", validation.missing.length > 0 ? validation.missing.join(", ") : "none");
  await writeField(io, "apiKey", validation.credentials.apiKey);
  if ("apiKeyEnv" in validation.credentials) {
    await writeField(io, "apiKeyEnv", validation.credentials.apiKeyEnv);
  }
  await writeField(io, "requiredApiKeyEnv", "required" in validation.credentials ? validation.credentials.required.join(" or ") : "none");
  await writeField(io, "baseUrl", validation.baseUrl.status);
  if ("baseUrlEnv" in validation.baseUrl) {
    await writeField(io, "baseUrlEnv", validation.baseUrl.baseUrlEnv);
  }
  if ("defaultUrl" in validation.baseUrl) {
    await writeField(io, "baseUrlDefault", validation.baseUrl.defaultUrl);
  }
}

export async function gatewayCommand(args: string[], io: CliIO): Promise<number> {
  const [command, ...rest] = args;
  if (command !== "init") {
    await write(io.stderr, "Usage: tokendance gateway init [--model model] [--base-url url]\n");
    return 1;
  }

  const parsed = parseGatewayInitArgs(rest);
  if (!parsed) {
    await write(io.stderr, "Usage: tokendance gateway init [--model model] [--base-url url]\n");
    return 1;
  }

  const envDir = join(homeDirFor(io), ".tokendance");
  const envPath = join(envDir, ".env");
  await mkdir(envDir, { recursive: true });
  let current = "";
  try {
    current = await readFile(envPath, "utf8");
  } catch {
    current = "";
  }

  await writeFile(
    envPath,
    updateEnvFile(current, {
      TOKENDANCE_PROVIDER: "openai-chat-completions",
      TOKENDANCE_MODEL: parsed.model,
      TOKENDANCE_GATEWAY_BASE_URL: parsed.baseUrl
    }),
    "utf8"
  );

  await write(io.stdout, `Configured TokenDance Gateway preset in ${envPath}\n`);
  await write(io.stdout, "Next steps:\n");
  await write(io.stdout, `1. Add TOKENDANCE_GATEWAY_API_KEY to ${envPath} or the current shell.\n`);
  await write(io.stdout, "2. Run tokendance config validate to confirm provider/model/base URL readiness.\n");
  await write(io.stdout, "3. Use TokenDance API keys for Gateway calls; TokenDanceID login tokens are not model API keys.\n");
  return 0;
}

export async function authCommand(args: string[], io: CliIO): Promise<number> {
  const [provider, command, ...rest] = args;
  if (provider !== "tokendanceid" || command !== "login-url") {
    await write(io.stderr, tokenDanceIdLoginUsage());
    return 1;
  }

  const parsed = parseTokenDanceIdLoginArgs(rest);
  if (!parsed) {
    await write(io.stderr, tokenDanceIdLoginUsage());
    return 1;
  }

  try {
    const login = createTokenDanceIdLoginRequest({
      issuerUrl: parsed.issuerUrl,
      clientId: parsed.clientId,
      redirectUri: parsed.redirectUri,
      scope: parsed.scope,
      state: parsed.state,
      nonce: parsed.nonce,
      codeVerifier: parsed.codeVerifier,
      extraParams: {
        device_type: parsed.deviceType,
        device_id: parsed.deviceId
      }
    });

    if (parsed.json) {
      await write(io.stdout, `${JSON.stringify({ ...login, diagnostics: diagnoseTokenDanceIdLoginRequest(login) }, null, 2)}\n`);
      return 0;
    }

    await write(io.stdout, "TokenDanceID authorize URL:\n");
    await write(io.stdout, `${login.authorizationUrl}\n`);
    await write(io.stdout, `State: ${login.state}\n`);
    await write(io.stdout, `Nonce: ${login.nonce}\n`);
    await write(io.stdout, `Code verifier: ${login.codeVerifier}\n`);
    await write(io.stdout, "Exchange the code on AgentHub Hub Server; this CLI does not store TokenDanceID tokens.\n");
    await write(io.stdout, "TokenDanceID login tokens are not TokenDance Gateway model API keys.\n");
    return 0;
  } catch (error) {
    await write(io.stderr, `${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

// --- arg parsing ---

function parseGatewayInitArgs(args: string[]): { model: string; baseUrl: string } | undefined {
  let model = "deepseek-v4-pro";
  let baseUrl = "https://api.vectorcontrol.tech/v1";
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--model") {
      const value = args[index + 1]?.trim();
      if (!value) { return undefined; }
      model = value;
      index += 1;
      continue;
    }
    if (arg === "--base-url") {
      const value = args[index + 1]?.trim();
      if (!value) { return undefined; }
      baseUrl = value;
      index += 1;
      continue;
    }
    return undefined;
  }
  return { model, baseUrl };
}

function configFormat(args: string[]): "text" | "json" {
  return args.some((arg, index) => isConfigJsonArg(arg, index)) ? "json" : "text";
}

function stripConfigFormatArgs(args: string[]): string[] {
  return args.filter((arg, index) => !isConfigJsonArg(arg, index));
}

function isConfigJsonArg(arg: string, index: number): boolean {
  return arg === "--json" || (arg === "json" && index === 0);
}

function parseConfigSetArgs(args: string[]): { scope: ConfigWriteScope; config: ConfigPatch } | { error: string } {
  let scope: ConfigWriteScope = "project";
  const config: ConfigPatch = {};

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--global") { scope = "global"; continue; }
    if (arg === "--project") { scope = "project"; continue; }

    const field = normalizeConfigField(arg);
    if (!field) { return { error: `Refusing to write unsafe config field: ${arg}` }; }

    const value = args[index + 1]?.trim();
    if (!value) { return { error: `Missing value for config field: ${arg}` }; }

    if (field === "provider") {
      if (!configProviders.has(value)) { return { error: `Invalid provider: ${value}` }; }
      config.provider = value as ConfigPatch["provider"];
    } else if (field === "model") {
      config.model = value;
    } else if (field === "permissionMode") {
      if (!permissionModes.has(value as PermissionMode)) { return { error: `Invalid permission mode: ${value}` }; }
      config.permissionMode = value as PermissionMode;
    }
    index += 1;
  }

  if (Object.keys(config).length === 0) { return { error: "No config fields provided." }; }
  return { scope, config };
}

function normalizeConfigField(value: string | undefined): keyof ConfigPatch | undefined {
  if (value === "provider" || value === "model") { return value; }
  if (value === "permissionMode" || value === "permission-mode" || value === "permission_mode") { return "permissionMode"; }
  return undefined;
}

function configSetUsage(): string {
  return "Usage: tokendance config set [--json] [--project|--global] provider <provider> model <model> permission-mode <default|safe|auto|yolo>\n";
}

function parseTokenDanceIdLoginArgs(args: string[]):
  | {
      issuerUrl?: string; clientId: string; redirectUri: string;
      scope?: string; state?: string; nonce?: string; codeVerifier?: string;
      deviceType?: string; deviceId?: string; json: boolean;
    }
  | undefined {
  const parsed: {
    issuerUrl?: string; clientId?: string; redirectUri?: string;
    scope?: string; state?: string; nonce?: string; codeVerifier?: string;
    deviceType?: string; deviceId?: string; json: boolean;
  } = { json: false };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--json") { parsed.json = true; continue; }
    const value = args[index + 1]?.trim();
    if (!value) { return undefined; }
    if (arg === "--issuer-url") { parsed.issuerUrl = value; }
    else if (arg === "--client-id") { parsed.clientId = value; }
    else if (arg === "--redirect-uri") { parsed.redirectUri = value; }
    else if (arg === "--scope") { parsed.scope = value; }
    else if (arg === "--state") { parsed.state = value; }
    else if (arg === "--nonce") { parsed.nonce = value; }
    else if (arg === "--code-verifier") { parsed.codeVerifier = value; }
    else if (arg === "--device-type") { parsed.deviceType = value; }
    else if (arg === "--device-id") { parsed.deviceId = value; }
    else { return undefined; }
    index += 1;
  }
  if (!parsed.clientId || !parsed.redirectUri) { return undefined; }
  return {
    issuerUrl: parsed.issuerUrl, clientId: parsed.clientId, redirectUri: parsed.redirectUri,
    scope: parsed.scope, state: parsed.state, nonce: parsed.nonce, codeVerifier: parsed.codeVerifier,
    deviceType: parsed.deviceType, deviceId: parsed.deviceId, json: parsed.json
  };
}

function tokenDanceIdLoginUsage(): string {
  return "Usage: tokendance auth tokendanceid login-url --client-id <id> --redirect-uri <uri> [--issuer-url url] [--scope scope] [--state state] [--nonce nonce] [--code-verifier verifier] [--device-type type] [--device-id id] [--json]\n";
}

function updateEnvFile(content: string, values: Record<string, string>): string {
  const seen = new Set<string>();
  const lines = content.split(/\r?\n/).filter((line, index, all) => index < all.length - 1 || line.length > 0);
  const updated = lines.map((line) => {
    const key = envLineKey(line);
    if (!key || !(key in values)) { return line; }
    seen.add(key);
    return `${key}=${values[key]}`;
  });
  for (const [key, value] of Object.entries(values)) {
    if (!seen.has(key)) { updated.push(`${key}=${value}`); }
  }
  return `${updated.join("\n")}\n`;
}

function envLineKey(line: string): string | undefined {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("#")) { return undefined; }
  const separatorIndex = trimmed.indexOf("=");
  if (separatorIndex <= 0) { return undefined; }
  const key = trimmed.slice(0, separatorIndex).trim();
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(key) ? key : undefined;
}

function yesNo(value: boolean): "yes" | "no" { return value ? "yes" : "no"; }
async function writeSection(io: CliIO, title: string, style: CliStyle): Promise<void> { await write(io.stdout, `== ${heading(title, style)} ==\n`); }
async function writeField(io: CliIO, name: string, value: string): Promise<void> { await write(io.stdout, `  ${name}: ${value}\n`); }
