#!/usr/bin/env node
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import { TokenDanceCode, type PermissionMode, type Thread } from "@tokendance/code-sdk";

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
    await printDoctor(io);
    return 0;
  }

  if (command === "run") {
    const prompt = rest.join(" ").trim();
    if (!prompt) {
      await write(io.stderr, "tokendance run requires a prompt\n");
      return 1;
    }
    const client = new TokenDanceCode();
    const thread = client.startThread({ workingDirectory: io.cwd() });
    const turn = await thread.run(prompt);
    await write(io.stdout, `${turn.finalResponse}\n`);
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
      await write(io.stdout, "bye\n");
      return;
    }

    if (line === "/help") {
      await printInteractiveHelp(io);
      continue;
    }

    if (line === "/status") {
      await printStatus(io, thread);
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

    const turn = await thread.run(line);
    await write(io.stdout, `${turn.finalResponse}\n`);
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

async function printStatus(io: CliIO, thread: Thread): Promise<void> {
  const state = thread.state;
  await write(io.stdout, `sessionId: ${state.id}\n`);
  await write(io.stdout, `cwd: ${state.cwd}\n`);
  await write(io.stdout, `permissionMode: ${state.permissionMode}\n`);
  await write(io.stdout, `messages: ${state.messages.length}\n`);
}

async function printDoctor(io: CliIO): Promise<void> {
  await write(io.stdout, `TokenDanceCode ${version}\n`);
  await write(io.stdout, `Node ${process.version}\n`);
  await write(io.stdout, `cwd ${io.cwd()}\n`);
  await write(io.stdout, `platform ${process.platform}\n`);
}

async function printHelp(io: CliIO): Promise<void> {
  await write(
    io.stdout,
    `TokenDanceCode ${version}

Usage:
  tokendance
  tokendance --version
  tokendance doctor
  tokendance run <prompt>
`
  );
}

async function printInteractiveHelp(io: CliIO): Promise<void> {
  await write(
    io.stdout,
    `Commands:
  /status
  /permissions [default|safe|auto|yolo]
  /exit
`
  );
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
