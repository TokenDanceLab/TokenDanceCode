#!/usr/bin/env node
import { createInterface } from "node:readline";
import { TokenDanceCode, type PermissionMode, type Thread } from "@tokendance/code-sdk";
import { runTopLevelCommand, type TopLevelCommandHandler, type TopLevelCommandId } from "./commands.js";
import { slashCommandUsage } from "./slash-commands.js";
import { styleFromEnv } from "./format.js";

// Module imports
import type { CliIO } from "./cli-io.js";
import { defaultIO, write, readCliEnv, isEntrypoint } from "./cli-io.js";
import { createLocalApprovalCallback } from "./approval.js";
import { runCommand, runPrompt, createConfiguredClient } from "./run-command.js";
import { configCommand, gatewayCommand, authCommand } from "./config-commands.js";
import { sessionsCommand, transcriptCommand, contextCommand, compactCommand, handleTranscript, handleContext, handleCompact } from "./session-commands.js";
import { memoryCommand, agentsCommand, diffCommand, reviewCommand, toolsCommand, qualityCommand, tasksCommand, todoCommand, worktreeCommand, warnUncommittedChanges } from "./project-commands.js";
import { printDoctor, printStatus, printHelp, printInteractiveHelp, printQuickstart, brandBanner, getVersion } from "./diagnostics.js";

const permissionModes = new Set<PermissionMode>(["default", "safe", "auto", "yolo"]);

export { CliIO };

export async function runCli(argv: string[], io: CliIO = defaultIO()): Promise<number> {
  return runTopLevelCommand(argv, {
    handlers: createTopLevelCommandHandlers(io),
    interactive: async () => {
      await runInteractive(io);
      return 0;
    },
    unknown: (command, args) => runCommand([command, ...args], io)
  });
}

function createTopLevelCommandHandlers(io: CliIO): Record<TopLevelCommandId, TopLevelCommandHandler> {
  return {
    help: async () => { await printHelp(io); return 0; },
    version: async () => { await write(io.stdout, `${getVersion()}\n`); return 0; },
    doctor: (args) => printDoctor(io, args),
    quickstart: async () => { await printQuickstart(io); return 0; },
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

// --- Interactive loop ---

async function runInteractive(io: CliIO): Promise<void> {
  const lines = createInterface({ input: io.stdin, crlfDelay: Infinity });
  const lineIterator = lines[Symbol.asyncIterator]();
  try {
    const configured = await createConfiguredClient(io, createLocalApprovalCallback(io, lineIterator));
    const client = configured.client;
    let thread = client.startThread({ workingDirectory: io.cwd(), permissionMode: configured.permissionMode });
    await write(io.stdout, `${brandBanner(styleFromEnv(await readCliEnv(io))).join("\n")}\n\n`);
    await write(io.stdout, "Type /help for commands, /exit to quit.\n");

    while (true) {
      const nextLine = await lineIterator.next();
      if (nextLine.done) { return; }
      const line = nextLine.value.trim();
      if (!line) { continue; }

      // Exit
      if (line === "/exit" || line === "/quit") {
        await warnUncommittedChanges(io);
        await write(io.stdout, "bye\n");
        return;
      }

      // Slash commands
      if (line === "/help") { await printInteractiveHelp(io); continue; }
      if (line === "/doctor" || line.startsWith("/doctor ")) { await printDoctor(io, line.split(/\s+/).slice(1)); continue; }
      if (line === "/quickstart") { await printQuickstart(io); continue; }
      if (line === "/config" || line.startsWith("/config ")) { await configCommand(line.split(/\s+/).slice(1), io); continue; }
      if (line === "/status") { await printStatus(io, thread); continue; }
      if (line === "/new") { thread = await handleNewThread(io, client, thread); continue; }
      if (line === "/resume") { thread = await handleResume(io, client); continue; }
      if (line === "/sessions") { await sessionsCommand(io); continue; }
      if (line === "/memory" || line.startsWith("/memory ")) { await memoryCommand(line.split(/\s+/).slice(1), io); continue; }
      if (line === "/auth" || line.startsWith("/auth ")) { await authCommand(line.split(/\s+/).slice(1), io); continue; }
      if (line === "/agents" || line.startsWith("/agents ")) { await agentsCommand(line.split(/\s+/).slice(1), io); continue; }
      if (line === "/diff" || line.startsWith("/diff ")) { await diffCommand(line.split(/\s+/).slice(1), io); continue; }
      if (line === "/review") { await reviewCommand(io); continue; }
      if (line === "/tools") { await toolsCommand(io); continue; }
      if (line.startsWith("/quality")) { await qualityCommand(line.split(/\s+/).slice(1), io); continue; }
      if (line === "/tasks" || line.startsWith("/tasks ")) { await tasksCommand(line.split(/\s+/).slice(1), io); continue; }
      if (line === "/todo" || line.startsWith("/todo ")) { await todoCommand(line.split(/\s+/).slice(1), io); continue; }
      if (line === "/worktree" || line.startsWith("/worktree ")) { await worktreeCommand(line.split(/\s+/).slice(1), io); continue; }
      if (line === "/transcript" || line.startsWith("/transcript ")) { await handleTranscript(io, thread, line); continue; }
      if (line === "/context" || line.startsWith("/context ")) { await handleContext(io, thread, line); continue; }
      if (line === "/compact") { await handleCompact(io, thread); continue; }
      if (line.startsWith("/permissions")) { thread = await handlePermissions(io, client, thread, line); continue; }

      // Unknown slash command
      if (line.startsWith("/")) {
        await write(io.stdout, `Unknown command: ${line}\n`);
        continue;
      }

      // Prompt
      await runPrompt(io, thread, line);
    }
  } finally {
    await lineIterator.return?.();
    lines.close();
  }
}

// --- Thread management helpers ---

async function handleNewThread(io: CliIO, client: TokenDanceCode, previous: Thread): Promise<Thread> {
  const thread = client.startThread({
    workingDirectory: previous.state.cwd,
    permissionMode: previous.state.permissionMode
  });
  await write(io.stdout, `Started new session ${thread.id}\n`);
  return thread;
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

async function handleResume(io: CliIO, client: TokenDanceCode): Promise<Thread> {
  const thread = await client.loadLatestThread(io.cwd());
  await printResumeResult(io, thread);
  return thread;
}

async function printResumeResult(io: CliIO, thread: Thread): Promise<void> {
  await write(io.stdout, `Resumed session ${thread.id} with ${thread.recentTranscript.length} recent transcript events.\n`);
}

async function handlePermissions(io: CliIO, client: TokenDanceCode, thread: Thread, line: string): Promise<Thread> {
  const [, rawMode] = line.split(/\s+/, 2);
  if (!rawMode) {
    await write(io.stdout, `permissionMode: ${thread.state.permissionMode}\n`);
    await write(io.stdout, "available: default, safe, auto, yolo\n");
    return thread;
  }
  if (!permissionModes.has(rawMode as PermissionMode)) {
    await write(io.stdout, `Usage: ${slashCommandUsage("permissions")}\n`);
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

// --- Entry point ---

if (isEntrypoint()) {
  runCli(process.argv.slice(2)).then((exitCode) => {
    process.exitCode = exitCode;
  }).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(message);
    process.exitCode = 1;
  });
}
