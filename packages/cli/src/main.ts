#!/usr/bin/env node
import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import {
  createTokenDanceIdLoginRequest,
  diagnoseTokenDanceIdLoginRequest,
  TokenDanceCode,
  type DoctorInfo,
  type AgentRunRecord,
  type MemoryScope,
  type PermissionMode,
  type SessionListItem,
  type ConfigPatch,
  type ConfigWriteScope,
  type Thread,
  type ThreadContext,
  type TokenDanceTools,
  type TokenDanceProviderConfig,
  type TranscriptInfo,
  type TranscriptSearchResult
} from "@tokendance/code-sdk";
import { groupedTopLevelCommands, runTopLevelCommand, type TopLevelCommandHandler, type TopLevelCommandId } from "./commands.js";
import { createEventRenderer } from "./renderer.js";
import { heading, styleFromEnv, type CliStyle } from "./format.js";

const version = "0.2.0-ts.0";
const permissionModes = new Set<PermissionMode>(["default", "safe", "auto", "yolo"]);
const configProviders = new Set(["mock", "openai-responses", "openai-chat-completions", "anthropic-messages"]);

export interface CliIO {
  stdin: Readable;
  stdout: Writable;
  stderr: Writable;
  cwd: () => string;
  homeDir?: () => string;
  env?: () => Record<string, string | undefined>;
}

export async function runCli(argv: string[], io: CliIO = defaultIO()): Promise<number> {
  return runTopLevelCommand(argv, {
    handlers: createTopLevelCommandHandlers(io),
    interactive: async () => {
      await runInteractive(io);
      return 0;
    },
    unknown: async (command) => {
      await write(io.stderr, `Unknown command: ${command}\n`);
      return 1;
    }
  });
}

function createTopLevelCommandHandlers(io: CliIO): Record<TopLevelCommandId, TopLevelCommandHandler> {
  return {
    help: async () => {
      await printHelp(io);
      return 0;
    },
    version: async () => {
      await write(io.stdout, `${version}\n`);
      return 0;
    },
    doctor: (args) => printDoctor(io, args),
    quickstart: async () => {
      await printQuickstart(io);
      return 0;
    },
    config: (args) => configCommand(args, io),
    gateway: (args) => gatewayCommand(args, io),
    auth: (args) => authCommand(args, io),
    resume: (args) => resumeCommand(args, io),
    sessions: () => sessionsCommand(io),
    memory: (args) => memoryCommand(args, io),
    agents: (args) => agentsCommand(args, io),
    diff: (args) => diffCommand(args, io),
    review: () => reviewCommand(io),
    tools: () => toolsCommand(io),
    quality: (args) => qualityCommand(args, io),
    tasks: (args) => tasksCommand(args, io),
    todo: (args) => todoCommand(args, io),
    worktree: (args) => worktreeCommand(args, io),
    transcript: (args) => transcriptCommand(args, io),
    context: (args) => contextCommand(args, io),
    compact: (args) => compactCommand(args, io),
    run: (args) => runCommand(args, io)
  };
}

async function runCommand(args: string[], io: CliIO): Promise<number> {
  const prompt = args.join(" ").trim();
  if (!prompt) {
    await write(io.stderr, "tokendance run requires a prompt\n");
    return 1;
  }
  const configured = await createConfiguredClient(io);
  const thread = configured.client.startThread({ workingDirectory: io.cwd(), permissionMode: configured.permissionMode });
  await runPrompt(io, thread, prompt);
  return 0;
}

async function runInteractive(io: CliIO): Promise<void> {
  const configured = await createConfiguredClient(io);
  const client = configured.client;
  let thread = client.startThread({ workingDirectory: io.cwd(), permissionMode: configured.permissionMode });
  await write(io.stdout, `TokenDanceCode ${version}\n`);
  await write(io.stdout, "Type /help for commands, /exit to quit.\n");

  const lines = createInterface({ input: io.stdin, crlfDelay: Infinity });
  for await (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) {
      continue;
    }

    if (line === "/exit" || line === "/quit") {
      await warnUncommittedChanges(io);
      await write(io.stdout, "bye\n");
      return;
    }

    if (line === "/help") {
      await printInteractiveHelp(io);
      continue;
    }

    if (line === "/doctor" || line.startsWith("/doctor ")) {
      await printDoctor(io, line.split(/\s+/).slice(1));
      continue;
    }

    if (line === "/quickstart") {
      await printQuickstart(io);
      continue;
    }

    if (line === "/config" || line.startsWith("/config ")) {
      await configCommand(line.split(/\s+/).slice(1), io);
      continue;
    }

    if (line === "/status") {
      await printStatus(io, thread);
      continue;
    }

    if (line === "/new") {
      thread = await handleNewThread(io, client, thread);
      continue;
    }

    if (line === "/resume") {
      thread = await handleResume(io, client);
      continue;
    }

    if (line === "/sessions") {
      await sessionsCommand(io);
      continue;
    }

    if (line === "/memory" || line.startsWith("/memory ")) {
      await memoryCommand(line.split(/\s+/).slice(1), io);
      continue;
    }

    if (line === "/auth" || line.startsWith("/auth ")) {
      await authCommand(line.split(/\s+/).slice(1), io);
      continue;
    }

    if (line === "/agents" || line.startsWith("/agents ")) {
      await agentsCommand(line.split(/\s+/).slice(1), io);
      continue;
    }

    if (line === "/diff" || line.startsWith("/diff ")) {
      await diffCommand(line.split(/\s+/).slice(1), io);
      continue;
    }

    if (line === "/review") {
      await reviewCommand(io);
      continue;
    }

    if (line === "/tools") {
      await toolsCommand(io);
      continue;
    }

    if (line.startsWith("/quality")) {
      await qualityCommand(line.split(/\s+/).slice(1), io);
      continue;
    }

    if (line === "/tasks" || line.startsWith("/tasks ")) {
      await tasksCommand(line.split(/\s+/).slice(1), io);
      continue;
    }

    if (line === "/todo" || line.startsWith("/todo ")) {
      await todoCommand(line.split(/\s+/).slice(1), io);
      continue;
    }

    if (line === "/worktree" || line.startsWith("/worktree ")) {
      await worktreeCommand(line.split(/\s+/).slice(1), io);
      continue;
    }

    if (line === "/transcript" || line.startsWith("/transcript ")) {
      await handleTranscript(io, thread, line);
      continue;
    }

    if (line === "/context" || line.startsWith("/context ")) {
      await handleContext(io, thread, line);
      continue;
    }

    if (line === "/compact") {
      await handleCompact(io, thread);
      continue;
    }

    if (line.startsWith("/permissions")) {
      thread = await handlePermissions(io, client, thread, line);
      continue;
    }

    if (line.startsWith("/")) {
      await write(io.stdout, `Unknown command: ${line}\n`);
      continue;
    }

    await runPrompt(io, thread, line);
  }
}

async function warnUncommittedChanges(io: CliIO): Promise<void> {
  const result = await new TokenDanceCode().tools({ workingDirectory: io.cwd() }).execute("git_status");
  if (!result.ok) {
    return;
  }

  const status = gitOutput(result.output).stdout.trim();
  if (!status) {
    return;
  }

  await write(io.stdout, "Uncommitted changes detected:\n");
  await write(io.stdout, `${status}\n`);
}

async function resumeCommand(args: string[], io: CliIO): Promise<number> {
  const client = new TokenDanceCode();
  const sessionId = args[0]?.trim();
  try {
    const thread = await client.resume({ sessionId, storageRoot: io.cwd() });
    await printResumeResult(io, thread);
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await write(io.stderr, `${message}\n`);
    return 1;
  }
}

async function memoryCommand(args: string[], io: CliIO): Promise<number> {
  const memory = new TokenDanceCode().memory({ projectRoot: io.cwd() });
  const [command, rawScope, ...rest] = args;
  const scope = parseMemoryScope(rawScope);

  if (!command) {
    await printMemoryEntries(io, memory, "project");
    await printMemoryEntries(io, memory, "global");
    return 0;
  }

  if (command === "add") {
    const text = rest.join(" ").trim();
    if (!scope || !text) {
      await write(io.stderr, "Usage: tokendance memory add project|global <text>\n");
      return 1;
    }
    await memory.add(scope, text);
    await write(io.stdout, `Added ${scope} memory.\n`);
    return 0;
  }

  if (command === "delete") {
    const index = Number.parseInt(rest[0] ?? "", 10);
    if (!scope || Number.isNaN(index)) {
      await write(io.stderr, "Usage: tokendance memory delete project|global <index>\n");
      return 1;
    }
    await memory.delete(scope, index);
    await write(io.stdout, `Deleted ${scope} memory ${index}.\n`);
    return 0;
  }

  await write(io.stderr, "Usage: tokendance memory [add|delete] [project|global] [value]\n");
  return 1;
}

async function configCommand(args: string[], io: CliIO): Promise<number> {
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

async function gatewayCommand(args: string[], io: CliIO): Promise<number> {
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

async function authCommand(args: string[], io: CliIO): Promise<number> {
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

async function agentsCommand(args: string[], io: CliIO): Promise<number> {
  const agents = new TokenDanceCode().subagents({ projectRoot: io.cwd() });
  const [command, rawType, ...promptParts] = args;
  try {
    if (!command) {
      await printAgents(io, await agents.list());
      return 0;
    }
    if (command === "show" && rawType) {
      const agent = await agents.get(rawType);
      if (!agent) {
        await write(io.stderr, `Subagent ${rawType} was not found.\n`);
        return 1;
      }
      await printAgentDetail(io, agent);
      return 0;
    }
    if (command === "accept" && rawType) {
      const accepted = await agents.accept(rawType, {
        discardWorktree: promptParts.includes("--discard-worktree"),
        allowDirtyTarget: promptParts.includes("--allow-dirty-target")
      });
      await write(io.stdout, `Accepted subagent ${accepted.id} worktree ${accepted.worktree}.\n`);
      return 0;
    }
    if (command === "discard" && rawType) {
      const discarded = await agents.discard(rawType, { discard: promptParts.includes("--discard") });
      await write(io.stdout, `Discarded subagent ${discarded.id} worktree ${discarded.worktree}.\n`);
      return 0;
    }
    if (command === "run") {
      const parsed = parseAgentRunArgs(rawType, promptParts);
      if (!parsed) {
        await write(io.stderr, agentUsage());
        return 1;
      }
      const result = parsed.agentType === "coding"
        ? await agents.runCoding({ prompt: parsed.prompt, worktree: parsed.worktree })
        : await agents.runReadonly({ agentType: parsed.agentType, prompt: parsed.prompt });
      await write(io.stdout, `${result.id} [${result.agentType}] ${result.summary}\n`);
      if (result.worktreePath) {
        await write(io.stdout, `worktree: ${result.worktreePath}\n`);
      }
      return 0;
    }
    await write(io.stderr, agentUsage());
    return 1;
  } catch (error) {
    await write(io.stderr, `${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

async function diffCommand(paths: string[], io: CliIO): Promise<number> {
  const result = await new TokenDanceCode().tools({ workingDirectory: io.cwd() }).execute("git_diff", { paths });
  if (!result.ok) {
    await write(io.stderr, `${result.error ?? "git diff failed"}\n`);
    return 1;
  }

  const output = gitOutput(result.output);
  await write(io.stdout, output.stdout.trim() ? output.stdout : "No git diff.\n");
  return 0;
}

async function reviewCommand(io: CliIO): Promise<number> {
  const result = await new TokenDanceCode().tools({ workingDirectory: io.cwd() }).execute("git_review");
  if (!result.ok) {
    await write(io.stderr, `${result.error ?? "git review failed"}\n`);
    return 1;
  }

  const findings = reviewFindings(result.output);
  if (findings.length === 0) {
    await write(io.stdout, "No review findings.\n");
    return 0;
  }

  for (const finding of findings) {
    await write(io.stdout, `[${finding.severity}] ${finding.message}\n`);
  }
  return 0;
}

async function toolsCommand(io: CliIO): Promise<number> {
  await printToolMetadata(io, new TokenDanceCode().tools({ workingDirectory: io.cwd() }));
  return 0;
}

async function qualityCommand(args: string[], io: CliIO): Promise<number> {
  const format = qualityFormat(args);
  const command = stripQualityFormatArgs(args).join(" ").trim();

  const result = await new TokenDanceCode()
    .tools({ workingDirectory: io.cwd() })
    .execute("quality_gate", command ? { command, timeout: 60 } : { timeout: 60 }, { permissionMode: "yolo" });
  if (!result.ok) {
    await write(io.stderr, `${result.error ?? "quality failed"}\n`);
    return 1;
  }

  const quality = qualityOutput(result.output);
  if (format === "json") {
    await write(io.stdout, `${JSON.stringify(quality, null, 2)}\n`);
    return quality.passed ? 0 : 1;
  }

  await write(io.stdout, quality.passed ? "Quality passed.\n" : "Quality failed.\n");
  if (quality.result.stdout.trim()) {
    await write(io.stdout, quality.result.stdout);
  }
  if (quality.result.stderr.trim()) {
    await write(io.stderr, quality.result.stderr);
  }
  return quality.passed ? 0 : 1;
}

function qualityFormat(args: string[]): "text" | "json" {
  return args[0] === "--json" || args[0] === "json" ? "json" : "text";
}

function stripQualityFormatArgs(args: string[]): string[] {
  return qualityFormat(args) === "json" ? args.slice(1) : args;
}

async function tasksCommand(args: string[], io: CliIO): Promise<number> {
  const tasks = new TokenDanceCode().tasks({ projectRoot: io.cwd() });
  const [command, id, ...rest] = args;
  try {
    if (!command) {
      await printTasks(io, await tasks.list());
      return 0;
    }
    if (command === "create") {
      const title = [id, ...rest].filter(Boolean).join(" ").trim();
      if (!title) {
        await write(io.stderr, "Usage: tokendance tasks create <title>\n");
        return 1;
      }
      const task = await tasks.create({ title });
      await write(io.stdout, `Created task ${task.id}.\n`);
      return 0;
    }
    if (command === "done" && id) {
      const task = await tasks.updateStatus(id, "completed");
      await write(io.stdout, `Updated task ${task.id} to ${task.status}.\n`);
      return 0;
    }
    if (command === "doing" && id) {
      const task = await tasks.updateStatus(id, "in_progress");
      await write(io.stdout, `Updated task ${task.id} to ${task.status}.\n`);
      return 0;
    }
    if (command === "link-session") {
      const sessionId = rest.join(" ").trim();
      if (!id || !sessionId) {
        await write(io.stderr, "Usage: tokendance tasks link-session <task-id> <session-id>\n");
        return 1;
      }
      const task = await tasks.linkSession(id, sessionId);
      await write(io.stdout, `Linked task ${task.id} to session ${task.linkedSessionId}.\n`);
      return 0;
    }
    if (command === "link-worktree") {
      const worktree = rest.join(" ").trim();
      if (!id || !worktree) {
        await write(io.stderr, "Usage: tokendance tasks link-worktree <task-id> <worktree>\n");
        return 1;
      }
      const task = await tasks.linkWorktree(id, worktree);
      await write(io.stdout, `Linked task ${task.id} to worktree ${task.linkedWorktree}.\n`);
      return 0;
    }
    await write(io.stderr, "Usage: tokendance tasks [create|doing|done|link-session|link-worktree] [value]\n");
    return 1;
  } catch (error) {
    await write(io.stderr, `${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

async function todoCommand(args: string[], io: CliIO): Promise<number> {
  const todos = new TokenDanceCode().todos({ projectRoot: io.cwd() });
  const [command, id, ...rest] = args;
  try {
    if (!command) {
      await printTodos(io, await todos.list());
      return 0;
    }
    if (command === "add") {
      const { text, taskId } = parseTodoAddArgs(id ? [id, ...rest] : rest);
      if (!text) {
        await write(io.stderr, "Usage: tokendance todo add <text> [--task task-id]\n");
        return 1;
      }
      const todo = await todos.add({ text, taskId });
      await write(io.stdout, `Created todo ${todo.id}.\n`);
      return 0;
    }
    if (command === "done" && id) {
      const todo = await todos.updateStatus(id, "completed");
      await write(io.stdout, `Updated todo ${todo.id} to ${todo.status}.\n`);
      return 0;
    }
    if (command === "doing" && id) {
      const todo = await todos.updateStatus(id, "in_progress");
      await write(io.stdout, `Updated todo ${todo.id} to ${todo.status}.\n`);
      return 0;
    }
    await write(io.stderr, "Usage: tokendance todo [add|doing|done] [value]\n");
    return 1;
  } catch (error) {
    await write(io.stderr, `${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

async function worktreeCommand(args: string[], io: CliIO): Promise<number> {
  const worktrees = new TokenDanceCode().worktrees({ repositoryRoot: io.cwd() });
  const [command, name, ...rest] = args;
  try {
    if (!command || command === "list") {
      await printWorktrees(io, await worktrees.list());
      return 0;
    }
    if (command === "create" && name) {
      const worktree = await worktrees.create({ name });
      await write(io.stdout, `Created worktree ${worktree.name}.\n`);
      await write(io.stdout, `${worktree.path}\n`);
      return 0;
    }
    if (command === "remove" && name) {
      await worktrees.remove(name, { discard: rest.includes("--discard") });
      await write(io.stdout, `Removed worktree ${name}.\n`);
      return 0;
    }
    await write(io.stderr, "Usage: tokendance worktree [list|create|remove] [name] [--discard]\n");
    return 1;
  } catch (error) {
    await write(io.stderr, `${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

async function transcriptCommand(args: string[], io: CliIO): Promise<number> {
  const client = new TokenDanceCode();
  const parsed = parseTranscriptArgs(args);
  try {
    const thread = await client.resume({ sessionId: parsed.sessionId, storageRoot: io.cwd() });
    if (parsed.query) {
      await printTranscriptSearchResults(io, await thread.searchTranscript(parsed.query));
    } else {
      await printTranscriptInfo(io, await thread.transcript());
    }
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await write(io.stderr, `${message}\n`);
    return 1;
  }
}

async function sessionsCommand(io: CliIO): Promise<number> {
  try {
    await printSessions(io, await new TokenDanceCode().sessions({ storageRoot: io.cwd() }).list());
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await write(io.stderr, `${message}\n`);
    return 1;
  }
}

async function contextCommand(args: string[], io: CliIO): Promise<number> {
  const parsed = parseContextArgs(args);
  if (!parsed.prompt) {
    await write(io.stderr, "Usage: tokendance context [--session session-id] <prompt>\n");
    return 1;
  }

  const client = new TokenDanceCode();
  try {
    const thread = await client.resume({ sessionId: parsed.sessionId, storageRoot: io.cwd() });
    await printContextPreview(io, await thread.context(parsed.prompt));
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await write(io.stderr, `${message}\n`);
    return 1;
  }
}

async function compactCommand(args: string[], io: CliIO): Promise<number> {
  const client = new TokenDanceCode();
  const sessionId = args[0]?.trim();
  try {
    const result = await client.compact({ sessionId, storageRoot: io.cwd() });
    await printCompactResult(io, result);
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await write(io.stderr, `${message}\n`);
    return 1;
  }
}

async function handleNewThread(io: CliIO, client: TokenDanceCode, previous: Thread): Promise<Thread> {
  const thread = client.startThread({
    workingDirectory: previous.state.cwd,
    permissionMode: previous.state.permissionMode
  });
  await write(io.stdout, `Started new session ${thread.id}\n`);
  return thread;
}

async function runPrompt(io: CliIO, thread: Thread, prompt: string): Promise<void> {
  const streamed = await thread.runStreamed(prompt);
  const renderer = createEventRenderer({ stdout: io.stdout, color: styleFromEnv(await readCliEnv(io)).color });

  for await (const event of streamed.events) {
    await renderer.render(event);
  }
}

async function handlePermissions(io: CliIO, client: TokenDanceCode, thread: Thread, line: string): Promise<Thread> {
  const [, rawMode] = line.split(/\s+/, 2);
  if (!rawMode) {
    await write(io.stdout, `permissionMode: ${thread.state.permissionMode}\n`);
    await write(io.stdout, "available: default, safe, auto, yolo\n");
    return thread;
  }

  if (!permissionModes.has(rawMode as PermissionMode)) {
    await write(io.stdout, "Usage: /permissions default|safe|auto|yolo\n");
    return thread;
  }

  const next = client.resumeThread({
    ...thread.state,
    permissionMode: rawMode as PermissionMode,
    updatedAt: new Date().toISOString()
  });
  await write(io.stdout, `permissionMode: ${next.state.permissionMode}\n`);
  return next;
}

async function handleResume(io: CliIO, client: TokenDanceCode): Promise<Thread> {
  const thread = await client.loadLatestThread(io.cwd());
  await printResumeResult(io, thread);
  return thread;
}

async function printResumeResult(io: CliIO, thread: Thread): Promise<void> {
  await write(io.stdout, `Resumed session ${thread.id} with ${thread.recentTranscript.length} recent transcript events.\n`);
}

async function handleTranscript(io: CliIO, thread: Thread, line: string): Promise<void> {
  const [, subcommand, ...queryParts] = line.split(/\s+/);
  if (subcommand === "search") {
    await printTranscriptSearchResults(io, await thread.searchTranscript(queryParts.join(" ")));
    return;
  }
  await printTranscriptInfo(io, await thread.transcript());
}

async function handleContext(io: CliIO, thread: Thread, line: string): Promise<void> {
  const prompt = line.split(/\s+/).slice(1).join(" ").trim();
  if (!prompt) {
    await write(io.stdout, "Usage: /context <prompt>\n");
    return;
  }
  await printContextPreview(io, await thread.context(prompt));
}

async function printTranscriptInfo(io: CliIO, info: TranscriptInfo): Promise<void> {
  await write(io.stdout, `Transcript ${info.transcriptPath}\n`);
  await write(io.stdout, `sessionId: ${info.sessionId}\n`);
  await write(io.stdout, `sessionDir: ${info.sessionDir}\n`);
  await write(io.stdout, `Events: ${info.eventCount}\n`);
  await write(io.stdout, `Recent: ${info.recentEventCount}\n`);
}

async function printTranscriptSearchResults(io: CliIO, results: TranscriptSearchResult[]): Promise<void> {
  if (results.length === 0) {
    await write(io.stdout, "No transcript matches.\n");
    return;
  }

  for (const result of results) {
    await write(io.stdout, `seq ${result.seq} ${result.eventType} ${result.preview}\n`);
  }
}

async function printSessions(io: CliIO, sessions: SessionListItem[]): Promise<void> {
  if (sessions.length === 0) {
    await write(io.stdout, "No sessions.\n");
    return;
  }

  await writeSection(io, "Sessions", styleFromEnv(await readCliEnv(io)));
  for (const session of sessions) {
    const marker = session.latest ? "latest" : "session";
    const lastEvent = session.lastEventTimestamp ? ` lastEvent=${session.lastEventTimestamp}` : "";
    await write(io.stdout, `${marker} ${session.sessionId} events=${session.eventCount}${lastEvent} transcript=${session.transcriptPath}\n`);
  }
}

async function printContextPreview(io: CliIO, context: ThreadContext): Promise<void> {
  await write(io.stdout, `Context messages: ${context.messages.length}\n`);
  await write(io.stdout, `Included files: ${context.includedFiles.length > 0 ? context.includedFiles.join(", ") : "none"}\n`);
  for (const [index, message] of context.messages.entries()) {
    await write(io.stdout, `[${index}] ${message.role}: ${previewText(message.content)}\n`);
  }
}

async function printMemoryEntries(io: CliIO, memory: ReturnType<TokenDanceCode["memory"]>, scope: MemoryScope): Promise<void> {
  const entries = await memory.list(scope);
  if (entries.length === 0) {
    await write(io.stdout, `No ${scope} memory.\n`);
    return;
  }

  for (const [index, entry] of entries.entries()) {
    await write(io.stdout, `${scope}[${index}]: ${entry}\n`);
  }
}

async function printTasks(io: CliIO, tasks: Awaited<ReturnType<ReturnType<TokenDanceCode["tasks"]>["list"]>>): Promise<void> {
  if (tasks.length === 0) {
    await write(io.stdout, "No tasks.\n");
    return;
  }
  for (const task of tasks) {
    const linked = [task.linkedSessionId ? `session ${task.linkedSessionId}` : "", task.linkedWorktree ? `worktree ${task.linkedWorktree}` : ""]
      .filter(Boolean)
      .join(", ");
    await write(io.stdout, `[${task.status}] ${task.id} ${task.title}${linked ? ` (${linked})` : ""}\n`);
  }
}

async function printTodos(io: CliIO, todos: Awaited<ReturnType<ReturnType<TokenDanceCode["todos"]>["list"]>>): Promise<void> {
  if (todos.length === 0) {
    await write(io.stdout, "No todos.\n");
    return;
  }
  for (const todo of todos) {
    await write(io.stdout, `[${todo.status}] ${todo.id} ${todo.text}${todo.taskId ? ` (task ${todo.taskId})` : ""}\n`);
  }
}

async function printToolMetadata(io: CliIO, tools: TokenDanceTools): Promise<void> {
  for (const tool of tools.list()) {
    await write(io.stdout, `[${tool.risk}/${tool.concurrency}] ${tool.name} - ${tool.description}\n`);
  }
}

async function printAgents(io: CliIO, agents: Awaited<ReturnType<ReturnType<TokenDanceCode["subagents"]>["list"]>>): Promise<void> {
  if (agents.length === 0) {
    await write(io.stdout, "No subagents.\n");
    return;
  }
  for (const agent of agents) {
    const status = agent.status === "completed" ? "" : ` [${agent.status}]`;
    await write(io.stdout, `${agent.id} [${agent.agentType}]${status} ${agent.summary}\n`);
  }
}

async function printAgentDetail(io: CliIO, agent: AgentRunRecord): Promise<void> {
  await write(io.stdout, `${agent.id} [${agent.agentType}] ${agent.status}\n`);
  await write(io.stdout, `summary: ${agent.summary}\n`);
  await write(io.stdout, `readonly: ${agent.readonly}\n`);
  await write(io.stdout, `cwd: ${agent.cwd}\n`);
  if (agent.worktree) {
    await write(io.stdout, `worktree: ${agent.worktree}\n`);
  }
  if (agent.worktreePath) {
    await write(io.stdout, `worktreePath: ${agent.worktreePath}\n`);
  }
  if (agent.changedFiles.length > 0) {
    await write(io.stdout, `changedFiles: ${agent.changedFiles.join(", ")}\n`);
  }
  if (agent.validationResult) {
    await write(io.stdout, `validation: ${agent.validationResult}\n`);
  }
  await write(io.stdout, `transcript: ${agent.transcriptPath}\n`);
}

async function printWorktrees(io: CliIO, worktrees: Awaited<ReturnType<ReturnType<TokenDanceCode["worktrees"]>["list"]>>): Promise<void> {
  if (worktrees.length === 0) {
    await write(io.stdout, "No worktrees.\n");
    return;
  }
  for (const worktree of worktrees) {
    await write(io.stdout, `[${worktree.branch ?? "detached"}] ${worktree.name} ${worktree.path}\n`);
  }
}

async function handleCompact(io: CliIO, thread: Thread): Promise<void> {
  const result = await thread.compact();
  await printCompactResult(io, result);
}

async function printCompactResult(io: CliIO, result: Awaited<ReturnType<Thread["compact"]>>): Promise<void> {
  await write(io.stdout, `Compact summary ${result.path}\n`);
  await write(io.stdout, `Range: ${result.range}\n`);
  await write(io.stdout, `Events: ${result.eventCount}\n`);
}

async function printStatus(io: CliIO, thread: Thread): Promise<void> {
  const state = thread.state;
  await writeSection(io, "Status", styleFromEnv(await readCliEnv(io)));
  await writeField(io, "sessionId", state.id);
  await writeField(io, "cwd", state.cwd);
  await writeField(io, "permissionMode", state.permissionMode);
  await writeField(io, "messages", String(state.messages.length));
}

async function printDoctor(io: CliIO, args: string[] = []): Promise<number> {
  if (stripDoctorFormatArgs(args).length > 0) {
    await write(io.stderr, doctorUsage());
    return 1;
  }

  const doctor = await new TokenDanceCode({
    storageRoot: io.cwd(),
    env: await readCliEnv(io)
  }).doctor({ projectRoot: io.cwd(), homeDir: homeDirFor(io) });
  if (doctorFormat(args) === "json") {
    await write(io.stdout, `${JSON.stringify(doctor, null, 2)}\n`);
    return 0;
  }
  await printDoctorInfo(io, doctor);
  return 0;
}

function doctorFormat(args: string[]): "text" | "json" {
  return args.some((arg) => arg === "--json" || arg === "json") ? "json" : "text";
}

function stripDoctorFormatArgs(args: string[]): string[] {
  return args.filter((arg) => arg !== "--json" && arg !== "json");
}

function doctorUsage(): string {
  return "Usage: tokendance doctor [--json]\n";
}

function yesNo(value: boolean): "yes" | "no" {
  return value ? "yes" : "no";
}

async function printDoctorInfo(io: CliIO, doctor: DoctorInfo): Promise<void> {
  const env = await readCliEnv(io);
  const style = styleFromEnv(env);
  await write(io.stdout, `TokenDanceCode ${doctor.version}\n`);
  await writeSection(io, "Runtime", style);
  await writeField(io, "Node", doctor.node);
  await writeField(io, "cwd", doctor.cwd);
  await writeField(io, "platform", doctor.platform);
  await writeSection(io, "API Keys", style);
  await writeField(io, "api OPENAI_API_KEY", doctor.apiKeys.OPENAI_API_KEY);
  await writeField(io, "api ANTHROPIC_API_KEY", doctor.apiKeys.ANTHROPIC_API_KEY);
  await writeField(io, "api TOKENDANCE_GATEWAY_API_KEY", env.TOKENDANCE_GATEWAY_API_KEY?.trim() ? "present" : "missing");
  await writeSection(io, "Tools", style);
  await writeField(io, "git available", yesNo(doctor.git.available));
  await writeField(io, "git repository", yesNo(doctor.git.repository));
  await writeField(io, "powershell available", yesNo(doctor.powershell.available));
  await writeSection(io, "Config", style);
  await writeField(io, "project", doctor.config.projectConfigPath);
  await writeField(io, "global", doctor.config.globalConfigPath);
  await writeField(io, "sources", doctor.config.sources.join(","));
  await writeField(io, "provider", doctor.config.provider);
  await writeField(io, "model", doctor.config.model);
  await writeField(io, "provider ready", yesNo(doctor.config.validation.ready));
  await writeField(
    io,
    "provider missing",
    doctor.config.validation.missing.length > 0 ? doctor.config.validation.missing.join(", ") : "none"
  );
  await writeSection(io, "State", style);
  await writeField(io, "dir", doctor.stateDir.path);
  await writeField(io, "writable", yesNo(doctor.stateDir.writable));
}

async function printHelp(io: CliIO): Promise<void> {
  const style = styleFromEnv(io.env?.() ?? process.env);
  const lines = [`TokenDanceCode ${version}`, ""];
  for (const group of groupedTopLevelCommands()) {
    lines.push(heading(`${group.category}:`, style));
    for (const command of group.commands) {
      lines.push(`  ${command.usage}`);
    }
    lines.push("");
  }
  await write(io.stdout, `${lines.join("\n").trimEnd()}\n`);
}

async function printInteractiveHelp(io: CliIO): Promise<void> {
  const style = styleFromEnv(io.env?.() ?? process.env);
  await write(
    io.stdout,
    `Commands:
${heading("Session:", style)}
  /new
  /status
  /quickstart
  /permissions [default|safe|auto|yolo]
  /resume
  /sessions
  /memory [add|delete] [project|global] [value]
  /auth tokendanceid login-url --client-id <id> --redirect-uri <uri> [--json]
  /transcript [search <query>]
  /context <prompt>
  /compact

${heading("Work:", style)}
  /agents [run investigator|reviewer <prompt>]
  /agents run coding [--worktree name] <prompt>
  /agents show <agent-id>
  /agents accept <agent-id> [--discard-worktree] [--allow-dirty-target]
  /agents discard <agent-id> [--discard]
  /tasks [create|doing|done|link-session|link-worktree] [value]
  /todo [add|doing|done] [value]
  /worktree [list|create|remove] [name] [--discard]
  /diff [path ...]
  /review
  /tools
  /quality [json] [command]

${heading("Diagnostics:", style)}
  /doctor [json]
  /config [json]
  /config validate [json]
  /config set [json] [--project|--global] provider <provider> model <model> permission-mode <mode>

${heading("Gateway:", style)}
  tokendance gateway init [--model model] [--base-url url]

${heading("Exit:", style)}
  /exit
`
  );
}

async function printQuickstart(io: CliIO): Promise<void> {
  const style = styleFromEnv(io.env?.() ?? process.env);
  await write(
    io.stdout,
    `${heading("Quickstart", style)}
1. Verify install
   tokendance --version
   tokendance doctor
2. Choose provider
   Keep mock for local smoke tests, or configure OpenAI Responses, OpenAI-compatible Chat Completions, or Anthropic-compatible Messages.
3. TokenDance Gateway preset
   tokendance gateway init --model deepseek-v4-pro
   Then set TOKENDANCE_GATEWAY_API_KEY in the current shell or ~/.tokendance/.env.
4. TokenDanceID login URL helper
   tokendance auth tokendanceid login-url --client-id agenthub-local --redirect-uri http://127.0.0.1:48731/callback
   The helper prints an authorize URL and PKCE values only; it does not exchange or store tokens.
5. Doctor and config checks
   tokendance doctor
   tokendance doctor --json
   tokendance config

Read-only: does not write env files, print secrets, open a browser, publish packages, or touch production.
`
  );
}

function parseTranscriptArgs(args: string[]): { sessionId?: string; query?: string } {
  if (args[0] === "search") {
    return { query: args.slice(1).join(" ").trim() };
  }

  const sessionId = args[0]?.trim() || undefined;
  if (args[1] === "search") {
    return { sessionId, query: args.slice(2).join(" ").trim() };
  }

  return { sessionId };
}

function parseContextArgs(args: string[]): { sessionId?: string; prompt: string } {
  const sessionFlagIndex = args.indexOf("--session");
  if (sessionFlagIndex < 0) {
    return { prompt: args.join(" ").trim() };
  }

  return {
    sessionId: args[sessionFlagIndex + 1],
    prompt: args.filter((_, index) => index !== sessionFlagIndex && index !== sessionFlagIndex + 1).join(" ").trim()
  };
}

function parseMemoryScope(value: string | undefined): MemoryScope | undefined {
  return value === "project" || value === "global" ? value : undefined;
}

function parseReadonlyAgentType(value: string | undefined): "investigator" | "reviewer" | undefined {
  return value === "investigator" || value === "reviewer" ? value : undefined;
}

function parseAgentRunArgs(rawType: string | undefined, args: string[]): { agentType: "investigator" | "reviewer" | "coding"; prompt: string; worktree?: string } | undefined {
  const readonlyType = parseReadonlyAgentType(rawType);
  if (readonlyType) {
    const prompt = args.join(" ").trim();
    return prompt ? { agentType: readonlyType, prompt } : undefined;
  }
  if (rawType !== "coding") {
    return undefined;
  }
  const worktreeFlagIndex = args.indexOf("--worktree");
  const worktree = worktreeFlagIndex >= 0 ? args[worktreeFlagIndex + 1] : undefined;
  const promptParts = worktreeFlagIndex >= 0 ? args.filter((_, index) => index !== worktreeFlagIndex && index !== worktreeFlagIndex + 1) : args;
  const prompt = promptParts.join(" ").trim();
  if (!prompt || (worktreeFlagIndex >= 0 && !worktree)) {
    return undefined;
  }
  return { agentType: "coding", prompt, worktree };
}

function agentUsage(): string {
  return "Usage: tokendance agents [show <id> | accept <id> [--discard-worktree] [--allow-dirty-target] | discard <id> [--discard] | run investigator|reviewer <prompt> | run coding [--worktree name] <prompt>]\n";
}

function gitOutput(output: unknown): { stdout: string; stderr: string; exitCode: number | null } {
  if (typeof output === "object" && output !== null) {
    const candidate = output as { stdout?: unknown; stderr?: unknown; exitCode?: unknown };
    return {
      stdout: typeof candidate.stdout === "string" ? candidate.stdout : "",
      stderr: typeof candidate.stderr === "string" ? candidate.stderr : "",
      exitCode: typeof candidate.exitCode === "number" || candidate.exitCode === null ? candidate.exitCode : null
    };
  }
  return { stdout: "", stderr: "", exitCode: null };
}

function reviewFindings(output: unknown): Array<{ severity: string; message: string }> {
  if (typeof output !== "object" || output === null || !Array.isArray((output as { findings?: unknown }).findings)) {
    return [];
  }
  return (output as { findings: unknown[] }).findings.flatMap((finding) => {
    if (typeof finding !== "object" || finding === null) {
      return [];
    }
    const candidate = finding as { severity?: unknown; message?: unknown };
    if (typeof candidate.severity !== "string" || typeof candidate.message !== "string") {
      return [];
    }
    return [{ severity: candidate.severity, message: candidate.message }];
  });
}

function qualityOutput(output: unknown): { passed: boolean; result: { stdout: string; stderr: string; exitCode: number | null } } {
  if (typeof output === "object" && output !== null) {
    const candidate = output as { passed?: unknown; result?: unknown };
    return {
      passed: candidate.passed === true,
      result: gitOutput(candidate.result)
    };
  }
  return { passed: false, result: { stdout: "", stderr: "", exitCode: null } };
}

function parseTodoAddArgs(args: string[]): { text: string; taskId?: string } {
  const taskFlagIndex = args.indexOf("--task");
  if (taskFlagIndex < 0) {
    return { text: args.join(" ").trim() };
  }
  return {
    text: args.slice(0, taskFlagIndex).join(" ").trim(),
    taskId: args[taskFlagIndex + 1]
  };
}

async function createConfiguredClient(io: CliIO): Promise<{ client: TokenDanceCode; permissionMode: PermissionMode }> {
  const env = await readCliEnv(io);
  const baseClient = new TokenDanceCode({ storageRoot: io.cwd(), env });
  const info = await baseClient.config({ projectRoot: io.cwd(), homeDir: homeDirFor(io) });
  return {
    client: new TokenDanceCode({
      storageRoot: io.cwd(),
      provider: providerFromConfig(info.config, env),
      env
    }),
    permissionMode: info.config.permissionMode
  };
}

function providerFromConfig(
  config: Awaited<ReturnType<TokenDanceCode["config"]>>["config"],
  env: Record<string, string | undefined>
): TokenDanceProviderConfig {
  if (config.provider === "mock") {
    return { type: "mock" };
  }
  if (config.provider === "openai-responses" || config.provider === "openai-chat-completions") {
    return {
      type: config.provider,
      model: config.model
    };
  }
  return {
    type: config.provider,
    model: config.model
  };
}

function previewText(value: string): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length <= 140 ? normalized : `${normalized.slice(0, 137)}...`;
}

function parseGatewayInitArgs(args: string[]): { model: string; baseUrl: string } | undefined {
  let model = "deepseek-v4-pro";
  let baseUrl = "https://api.vectorcontrol.tech/v1";
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--model") {
      const value = args[index + 1]?.trim();
      if (!value) {
        return undefined;
      }
      model = value;
      index += 1;
      continue;
    }
    if (arg === "--base-url") {
      const value = args[index + 1]?.trim();
      if (!value) {
        return undefined;
      }
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
    if (arg === "--global") {
      scope = "global";
      continue;
    }
    if (arg === "--project") {
      scope = "project";
      continue;
    }

    const field = normalizeConfigField(arg);
    if (!field) {
      return { error: `Refusing to write unsafe config field: ${arg}` };
    }

    const value = args[index + 1]?.trim();
    if (!value) {
      return { error: `Missing value for config field: ${arg}` };
    }

    if (field === "provider") {
      if (!configProviders.has(value)) {
        return { error: `Invalid provider: ${value}` };
      }
      config.provider = value as ConfigPatch["provider"];
    } else if (field === "model") {
      config.model = value;
    } else if (field === "permissionMode") {
      if (!permissionModes.has(value as PermissionMode)) {
        return { error: `Invalid permission mode: ${value}` };
      }
      config.permissionMode = value as PermissionMode;
    }
    index += 1;
  }

  if (Object.keys(config).length === 0) {
    return { error: "No config fields provided." };
  }
  return { scope, config };
}

function normalizeConfigField(value: string | undefined): keyof ConfigPatch | undefined {
  if (value === "provider" || value === "model") {
    return value;
  }
  if (value === "permissionMode" || value === "permission-mode" || value === "permission_mode") {
    return "permissionMode";
  }
  return undefined;
}

function configSetUsage(): string {
  return "Usage: tokendance config set [--json] [--project|--global] provider <provider> model <model> permission-mode <default|safe|auto|yolo>\n";
}

function parseTokenDanceIdLoginArgs(args: string[]):
  | {
      issuerUrl?: string;
      clientId: string;
      redirectUri: string;
      scope?: string;
      state?: string;
      nonce?: string;
      codeVerifier?: string;
      deviceType?: string;
      deviceId?: string;
      json: boolean;
    }
  | undefined {
  const parsed: {
    issuerUrl?: string;
    clientId?: string;
    redirectUri?: string;
    scope?: string;
    state?: string;
    nonce?: string;
    codeVerifier?: string;
    deviceType?: string;
    deviceId?: string;
    json: boolean;
  } = { json: false };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--json") {
      parsed.json = true;
      continue;
    }

    const value = args[index + 1]?.trim();
    if (!value) {
      return undefined;
    }

    if (arg === "--issuer-url") {
      parsed.issuerUrl = value;
    } else if (arg === "--client-id") {
      parsed.clientId = value;
    } else if (arg === "--redirect-uri") {
      parsed.redirectUri = value;
    } else if (arg === "--scope") {
      parsed.scope = value;
    } else if (arg === "--state") {
      parsed.state = value;
    } else if (arg === "--nonce") {
      parsed.nonce = value;
    } else if (arg === "--code-verifier") {
      parsed.codeVerifier = value;
    } else if (arg === "--device-type") {
      parsed.deviceType = value;
    } else if (arg === "--device-id") {
      parsed.deviceId = value;
    } else {
      return undefined;
    }
    index += 1;
  }

  if (!parsed.clientId || !parsed.redirectUri) {
    return undefined;
  }

  return {
    issuerUrl: parsed.issuerUrl,
    clientId: parsed.clientId,
    redirectUri: parsed.redirectUri,
    scope: parsed.scope,
    state: parsed.state,
    nonce: parsed.nonce,
    codeVerifier: parsed.codeVerifier,
    deviceType: parsed.deviceType,
    deviceId: parsed.deviceId,
    json: parsed.json
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
    if (!key || !(key in values)) {
      return line;
    }
    seen.add(key);
    return `${key}=${values[key]}`;
  });

  for (const [key, value] of Object.entries(values)) {
    if (!seen.has(key)) {
      updated.push(`${key}=${value}`);
    }
  }

  return `${updated.join("\n")}\n`;
}

function envLineKey(line: string): string | undefined {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("#")) {
    return undefined;
  }
  const separatorIndex = trimmed.indexOf("=");
  if (separatorIndex <= 0) {
    return undefined;
  }
  const key = trimmed.slice(0, separatorIndex).trim();
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(key) ? key : undefined;
}

async function readCliEnv(io: CliIO): Promise<Record<string, string | undefined>> {
  return {
    ...(await readGlobalEnvFile(homeDirFor(io))),
    ...(io.env?.() ?? process.env)
  };
}

async function readGlobalEnvFile(homeDir: string): Promise<Record<string, string>> {
  try {
    return parseEnvFile(await readFile(join(homeDir, ".tokendance", ".env"), "utf8"));
  } catch {
    return {};
  }
}

function parseEnvFile(content: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }
    const separatorIndex = line.indexOf("=");
    if (separatorIndex <= 0) {
      continue;
    }
    const key = line.slice(0, separatorIndex).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      continue;
    }
    env[key] = unquoteEnvValue(line.slice(separatorIndex + 1).trim());
  }
  return env;
}

function unquoteEnvValue(value: string): string {
  if ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  return value;
}

async function writeSection(io: CliIO, title: string, style: CliStyle): Promise<void> {
  await write(io.stdout, `${heading(title, style)}\n`);
}

async function writeField(io: CliIO, name: string, value: string): Promise<void> {
  await write(io.stdout, `${name}: ${value}\n`);
}

function homeDirFor(io: CliIO): string {
  return io.homeDir?.() ?? process.env.USERPROFILE ?? process.env.HOME ?? io.cwd();
}

function defaultIO(): CliIO {
  return {
    stdin: process.stdin,
    stdout: process.stdout,
    stderr: process.stderr,
    cwd: () => process.cwd(),
    homeDir: () => process.env.USERPROFILE ?? process.env.HOME ?? process.cwd(),
    env: () => process.env
  };
}

function write(stream: Writable, text: string): Promise<void> {
  return new Promise((resolveWrite, reject) => {
    stream.write(text, (error) => {
      if (error) {
        reject(error);
        return;
      }
      resolveWrite();
    });
  });
}

if (isEntrypoint()) {
  runCli(process.argv.slice(2)).then((exitCode) => {
    process.exitCode = exitCode;
  }).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(message);
    process.exitCode = 1;
  });
}

function isEntrypoint(): boolean {
  const argvPath = process.argv[1];
  return argvPath !== undefined && fileURLToPath(import.meta.url) === resolve(argvPath);
}
