/**
 * Run command: text, JSON, and stream-JSON output modes.
 */
import type { Writable } from "node:stream";
import {
  TokenDanceCode,
  type PermissionMode,
  type PermissionApprovalCallback,
  type TDCodeEvent,
  type Thread,
  type TokenDanceProviderConfig
} from "@tokendance/code-sdk";
import { createEventRenderer } from "./renderer.js";
import { styleFromEnv } from "./format.js";
import { write, readCliEnv, homeDirFor, type CliIO } from "./cli-io.js";

export async function runCommand(args: string[], io: CliIO): Promise<number> {
  const parsed = parseRunArgs(args);
  if ("error" in parsed) {
    await write(io.stderr, `${parsed.error}\n`);
    return 1;
  }
  const prompt = parsed.prompt;
  if (!prompt) {
    if (parsed.format !== "text") {
      await writeStructuredRunFailure(io, parsed.format, "", "tokendance run requires a prompt");
      return 1;
    }
    await write(io.stderr, "tokendance run requires a prompt\n");
    return 1;
  }
  if (parsed.format !== "text") {
    try {
      const configured = await createConfiguredClient(io);
      const thread = configured.client.startThread({ workingDirectory: io.cwd(), permissionMode: configured.permissionMode });
      return runPromptStructured(io, thread, prompt, parsed.format);
    } catch (error) {
      await writeStructuredRunFailure(io, parsed.format, "", structureRunError(error));
      return 1;
    }
  }
  const configured = await createConfiguredClient(io);
  const thread = configured.client.startThread({ workingDirectory: io.cwd(), permissionMode: configured.permissionMode });
  await runPrompt(io, thread, prompt);
  return 0;
}

export async function runPrompt(io: CliIO, thread: Thread, prompt: string): Promise<void> {
  const streamed = await thread.runStreamed(prompt);
  const renderer = createEventRenderer({ stdout: io.stdout, color: styleFromEnv(await readCliEnv(io)).color });
  for await (const event of streamed.events) {
    await renderer.render(event);
  }
}

// --- structured output types ---

type RunOutputFormat = "text" | "json" | "stream-json";

interface RunCommandArgs {
  format: RunOutputFormat;
  prompt: string;
}

interface StructuredRunResult {
  schemaVersion: 1;
  command: "run";
  threadId: string;
  sessionId: string;
  success: boolean;
  finalResponse: string;
  events: StructuredRunEvent[];
  error: StructuredRunError | null;
}

type StructuredRunEvent = { schemaVersion: 1; command: "run"; threadId: string; eventType: TDCodeEvent["type"] } & TDCodeEvent;

interface StructuredRunTerminalEvent {
  schemaVersion: 1;
  command: "run";
  threadId: string;
  sessionId: string;
  eventType: "run.result";
  success: boolean;
  finalResponse: string;
  error: StructuredRunError | null;
}

interface StructuredRunError {
  name: string;
  message: string;
}

// --- structured output implementation ---

function parseRunArgs(args: string[]): RunCommandArgs | { error: string } {
  let format: RunOutputFormat = "text";
  const promptArgs: string[] = [];

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--") {
      promptArgs.push(...args.slice(index + 1));
      break;
    }
    if (arg === "--json" || arg === "--stream-json") {
      const nextFormat = arg === "--json" ? "json" : "stream-json";
      if (format !== "text" && format !== nextFormat) {
        return { error: "Usage: tokendance run [--json|--stream-json] <prompt>" };
      }
      format = nextFormat;
      continue;
    }
    promptArgs.push(...args.slice(index));
    break;
  }

  return { format, prompt: promptArgs.join(" ").trim() };
}

async function runPromptStructured(io: CliIO, thread: Thread, prompt: string, format: Exclude<RunOutputFormat, "text">): Promise<number> {
  const events: StructuredRunEvent[] = [];
  let finalResponse = "";

  try {
    const streamed = await thread.runStreamed(prompt);
    for await (const event of streamed.events) {
      const structuredEvent = structureRunEvent(thread.id, event);
      events.push(structuredEvent);
      if (event.type === "turn.completed") {
        finalResponse = event.finalResponse;
      }
      if (format === "stream-json") {
        await writeJsonLine(io.stdout, structuredEvent);
      }
    }
  } catch (error) {
    const structuredError = structureRunError(error);
    await writeStructuredRunResult(io, format, {
      schemaVersion: 1, command: "run", threadId: thread.id, sessionId: thread.id,
      success: false, finalResponse, events, error: structuredError
    });
    return 1;
  }

  await writeStructuredRunResult(io, format, {
    schemaVersion: 1, command: "run", threadId: thread.id, sessionId: thread.id,
    success: true, finalResponse, events, error: null
  });
  return 0;
}

async function writeStructuredRunFailure(
  io: CliIO,
  format: Exclude<RunOutputFormat, "text">,
  sessionId: string,
  error: string | StructuredRunError
): Promise<void> {
  const result: StructuredRunResult = {
    schemaVersion: 1, command: "run", threadId: sessionId, sessionId,
    success: false, finalResponse: "", events: [],
    error: typeof error === "string" ? { name: "Error", message: error } : error
  };
  await writeStructuredRunResult(io, format, result);
}

async function writeStructuredRunResult(
  io: CliIO,
  format: Exclude<RunOutputFormat, "text">,
  result: StructuredRunResult
): Promise<void> {
  if (format === "stream-json") {
    await writeJsonLine(io.stdout, terminalRunEvent(result));
    return;
  }
  await write(io.stdout, `${JSON.stringify(result)}\n`);
}

function structureRunEvent(threadId: string, event: TDCodeEvent): StructuredRunEvent {
  return { schemaVersion: 1, command: "run", threadId, eventType: event.type, ...event };
}

function terminalRunEvent(result: StructuredRunResult): StructuredRunTerminalEvent {
  return {
    schemaVersion: 1, command: "run", threadId: result.threadId, sessionId: result.sessionId,
    eventType: "run.result", success: result.success, finalResponse: result.finalResponse, error: result.error
  };
}

function structureRunError(error: unknown): StructuredRunError {
  if (error instanceof Error) { return { name: error.name || "Error", message: error.message }; }
  return { name: "Error", message: String(error) };
}

function writeJsonLine(stream: Writable, value: unknown): Promise<void> {
  return write(stream, `${JSON.stringify(value)}\n`);
}

// --- shared client factory ---

export async function createConfiguredClient(
  io: CliIO,
  approvalCallback?: PermissionApprovalCallback
): Promise<{ client: TokenDanceCode; permissionMode: PermissionMode }> {
  const env = await readCliEnv(io);
  const baseClient = new TokenDanceCode({ storageRoot: io.cwd(), env });
  const info = await baseClient.config({ projectRoot: io.cwd(), homeDir: homeDirFor(io) });
  return {
    client: new TokenDanceCode({
      storageRoot: io.cwd(),
      provider: providerFromConfig(info.config, env),
      approvalCallback,
      env
    }),
    permissionMode: info.config.permissionMode
  };
}

function providerFromConfig(
  config: Awaited<ReturnType<TokenDanceCode["config"]>>["config"],
  env: Record<string, string | undefined>
): TokenDanceProviderConfig {
  if (config.provider === "mock") { return { type: "mock" }; }
  return { type: config.provider, model: config.model };
}
