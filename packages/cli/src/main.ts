#!/usr/bin/env node
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import {
  TokenDanceCode,
  type DoctorInfo,
  type AgentRunRecord,
  type MemoryScope,
  type PermissionMode,
  type Thread,
  type ThreadContext,
  type TokenDanceTools,
  type TranscriptInfo,
  type TranscriptSearchResult
} from "@tokendance/code-sdk";
import { createEventRenderer } from "./renderer.js";

const version = "0.2.0-ts.0";
const permissionModes = new Set<PermissionMode>(["default", "safe", "auto", "yolo"]);

export interface CliIO {
  stdin: Readable;
  stdout: Writable;
  stderr: Writable;
  cwd: () => string;
}

export async function runCli(argv: string[], io: CliIO = defaultIO()): Promise<number> {
  const [command, ...rest] = argv;

  if (command === "--help" || command === "-h") {
    await printHelp(io);
    return 0;
  }

  if (command === "--version" || command === "-v") {
    await write(io.stdout, `${version}\n`);
    return 0;
  }

  if (command === "doctor") {
    await printDoctor(io, rest);
    return 0;
  }

  if (command === "config") {
    return configCommand(io);
  }

  if (command === "resume") {
    return resumeCommand(rest, io);
  }

  if (command === "memory") {
    return memoryCommand(rest, io);
  }

  if (command === "agents") {
    return agentsCommand(rest, io);
  }

  if (command === "diff") {
    return diffCommand(rest, io);
  }

  if (command === "review") {
    return reviewCommand(io);
  }

  if (command === "tools") {
    return toolsCommand(io);
  }

  if (command === "quality") {
    return qualityCommand(rest, io);
  }

  if (command === "tasks") {
    return tasksCommand(rest, io);
  }

  if (command === "todo") {
    return todoCommand(rest, io);
  }

  if (command === "worktree") {
    return worktreeCommand(rest, io);
  }

  if (command === "transcript") {
    return transcriptCommand(rest, io);
  }

  if (command === "context") {
    return contextCommand(rest, io);
  }

  if (command === "compact") {
    return compactCommand(rest, io);
  }

  if (command === "run") {
    const prompt = rest.join(" ").trim();
    if (!prompt) {
      await write(io.stderr, "tokendance run requires a prompt\n");
      return 1;
    }
    const client = new TokenDanceCode();
    const thread = client.startThread({ workingDirectory: io.cwd() });
    await runPrompt(io, thread, prompt);
    return 0;
  }

  if (!command) {
    await runInteractive(io);
    return 0;
  }

  await write(io.stderr, `Unknown command: ${command}\n`);
  return 1;
}

async function runInteractive(io: CliIO): Promise<void> {
  const client = new TokenDanceCode();
  let thread = client.startThread({ workingDirectory: io.cwd(), permissionMode: "default" });
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

    if (line === "/config") {
      await configCommand(io);
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

    if (line === "/memory" || line.startsWith("/memory ")) {
      await memoryCommand(line.split(/\s+/).slice(1), io);
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

async function configCommand(io: CliIO): Promise<number> {
  const info = await new TokenDanceCode().config({ projectRoot: io.cwd() });
  await write(io.stdout, `provider: ${info.config.provider}\n`);
  await write(io.stdout, `model: ${info.config.model}\n`);
  await write(io.stdout, `permissionMode: ${info.config.permissionMode}\n`);
  await write(io.stdout, `globalConfig: ${info.globalConfigPath}\n`);
  await write(io.stdout, `projectConfig: ${info.projectConfigPath}\n`);
  for (const source of info.sources) {
    await write(io.stdout, `source: ${source.kind}${source.path ? ` ${source.path}` : ""}\n`);
  }
  return 0;
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
  const command = args.join(" ").trim();

  const result = await new TokenDanceCode()
    .tools({ workingDirectory: io.cwd() })
    .execute("quality_gate", command ? { command, timeout: 60 } : { timeout: 60 }, { permissionMode: "yolo" });
  if (!result.ok) {
    await write(io.stderr, `${result.error ?? "quality failed"}\n`);
    return 1;
  }

  const quality = qualityOutput(result.output);
  await write(io.stdout, quality.passed ? "Quality passed.\n" : "Quality failed.\n");
  if (quality.result.stdout.trim()) {
    await write(io.stdout, quality.result.stdout);
  }
  if (quality.result.stderr.trim()) {
    await write(io.stderr, quality.result.stderr);
  }
  return quality.passed ? 0 : 1;
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
    await write(io.stderr, "Usage: tokendance tasks [create|doing|done] [value]\n");
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
  const renderer = createEventRenderer({ stdout: io.stdout });

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
    await write(io.stdout, `[${task.status}] ${task.id} ${task.title}\n`);
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
  await write(io.stdout, `sessionId: ${state.id}\n`);
  await write(io.stdout, `cwd: ${state.cwd}\n`);
  await write(io.stdout, `permissionMode: ${state.permissionMode}\n`);
  await write(io.stdout, `messages: ${state.messages.length}\n`);
}

async function printDoctor(io: CliIO, args: string[] = []): Promise<void> {
  const doctor = await new TokenDanceCode().doctor({ projectRoot: io.cwd() });
  if (doctorFormat(args) === "json") {
    await write(io.stdout, `${JSON.stringify(doctor, null, 2)}\n`);
    return;
  }
  await printDoctorInfo(io, doctor);
}

function doctorFormat(args: string[]): "text" | "json" {
  return args.some((arg) => arg === "--json" || arg === "json") ? "json" : "text";
}

function yesNo(value: boolean): "yes" | "no" {
  return value ? "yes" : "no";
}

async function printDoctorInfo(io: CliIO, doctor: DoctorInfo): Promise<void> {
  await write(io.stdout, `TokenDanceCode ${doctor.version}\n`);
  await write(io.stdout, `Node ${doctor.node}\n`);
  await write(io.stdout, `cwd ${doctor.cwd}\n`);
  await write(io.stdout, `platform ${doctor.platform}\n`);
  await write(io.stdout, `api OPENAI_API_KEY: ${doctor.apiKeys.OPENAI_API_KEY}\n`);
  await write(io.stdout, `api ANTHROPIC_API_KEY: ${doctor.apiKeys.ANTHROPIC_API_KEY}\n`);
  await write(io.stdout, `git available: ${yesNo(doctor.git.available)}\n`);
  await write(io.stdout, `git repository: ${yesNo(doctor.git.repository)}\n`);
  await write(io.stdout, `powershell available: ${yesNo(doctor.powershell.available)}\n`);
  await write(io.stdout, `config project: ${doctor.config.projectConfigPath}\n`);
  await write(io.stdout, `config global: ${doctor.config.globalConfigPath}\n`);
  await write(io.stdout, `config sources: ${doctor.config.sources.join(",")}\n`);
  await write(io.stdout, `state dir: ${doctor.stateDir.path}\n`);
  await write(io.stdout, `state writable: ${yesNo(doctor.stateDir.writable)}\n`);
}

async function printHelp(io: CliIO): Promise<void> {
  await write(
    io.stdout,
    `TokenDanceCode ${version}

Usage:
  tokendance
  tokendance --version
  tokendance doctor [--json]
  tokendance config
  tokendance memory [add|delete] [project|global] [value]
  tokendance agents [run investigator|reviewer <prompt>]
  tokendance agents run coding [--worktree name] <prompt>
  tokendance agents show <agent-id>
  tokendance agents accept <agent-id> [--discard-worktree] [--allow-dirty-target]
  tokendance agents discard <agent-id> [--discard]
  tokendance diff [path ...]
  tokendance review
  tokendance tools
  tokendance quality [command]
  tokendance tasks [create|doing|done] [value]
  tokendance todo [add|doing|done] [value]
  tokendance worktree [list|create|remove] [name] [--discard]
  tokendance resume [session-id]
  tokendance transcript [session-id]
  tokendance transcript search <query>
  tokendance transcript <session-id> search <query>
  tokendance context [--session session-id] <prompt>
  tokendance compact [session-id]
  tokendance run <prompt>
`
  );
}

async function printInteractiveHelp(io: CliIO): Promise<void> {
  await write(
    io.stdout,
    `Commands:
  /new
  /status
  /doctor [json]
  /config
  /permissions [default|safe|auto|yolo]
  /resume
  /memory [add|delete] [project|global] [value]
  /agents [run investigator|reviewer <prompt>]
  /agents run coding [--worktree name] <prompt>
  /agents show <agent-id>
  /agents accept <agent-id> [--discard-worktree] [--allow-dirty-target]
  /agents discard <agent-id> [--discard]
  /diff [path ...]
  /review
  /tools
  /quality [command]
  /tasks [create|doing|done] [value]
  /todo [add|doing|done] [value]
  /worktree [list|create|remove] [name] [--discard]
  /transcript [search <query>]
  /context <prompt>
  /compact
  /exit
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

function previewText(value: string): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length <= 140 ? normalized : `${normalized.slice(0, 137)}...`;
}

function defaultIO(): CliIO {
  return {
    stdin: process.stdin,
    stdout: process.stdout,
    stderr: process.stderr,
    cwd: () => process.cwd()
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
