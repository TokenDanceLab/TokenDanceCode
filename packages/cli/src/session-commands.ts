/**
 * Session, transcript, context, and compact CLI commands.
 */
import {
  TokenDanceCode,
  type SessionListItem,
  type Thread,
  type ThreadContext,
  type TranscriptInfo,
  type TranscriptSearchResult
} from "@tokendance/code-sdk";
import { heading, styleFromEnv } from "./format.js";
import { write, readCliEnv, type CliIO } from "./cli-io.js";
import { slashCommandUsage } from "./slash-commands.js";

// --- sessions command (with --json) ---

export async function sessionsCommand(args: string[], io: CliIO): Promise<number> {
  const json = args.includes("--json");
  try {
    const sessions = await new TokenDanceCode().sessions({ storageRoot: io.cwd() }).list();
    if (json) {
      await write(io.stdout, `${JSON.stringify(sessions, null, 2)}\n`);
      return 0;
    }
    await printSessions(io, sessions);
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await write(io.stderr, `${message}\n`);
    return 1;
  }
}

// --- transcript command (with --json, export, --jsonl) ---

export async function transcriptCommand(args: string[], io: CliIO): Promise<number> {
  const parsed = parseTranscriptArgs(args);
  const client = new TokenDanceCode();

  // transcript export <session-id> [--jsonl]
  if (parsed.subcommand === "export") {
    return transcriptExportCommand(parsed.sessionId, parsed.jsonl, io);
  }

  try {
    const thread = await client.resume({ sessionId: parsed.sessionId, storageRoot: io.cwd() });
    if (parsed.query) {
      const results = await thread.searchTranscript(parsed.query);
      if (parsed.json) {
        await write(io.stdout, `${JSON.stringify(results, null, 2)}\n`);
        return 0;
      }
      await printTranscriptSearchResults(io, results);
      return 0;
    }

    const info = await thread.transcript();
    if (parsed.json) {
      await write(io.stdout, `${JSON.stringify(info, null, 2)}\n`);
      return 0;
    }
    await printTranscriptInfo(io, info);
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await write(io.stderr, `${message}\n`);
    return 1;
  }
}

async function transcriptExportCommand(sessionId: string | undefined, jsonl: boolean, io: CliIO): Promise<number> {
  if (!sessionId) {
    await write(io.stderr, "Usage: tokendance transcript export <session-id> [--jsonl]\n");
    return 1;
  }
  try {
    const exported = await new TokenDanceCode().sessions({ storageRoot: io.cwd() }).export(sessionId);
    if (jsonl) {
      // transcriptJsonl is raw JSONL string, write line by line
      for (const line of exported.transcriptJsonl.split("\n")) {
        if (line.trim()) {
          await write(io.stdout, `${line}\n`);
        }
      }
      return 0;
    }
    await write(io.stdout, `${JSON.stringify(exported, null, 2)}\n`);
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await write(io.stderr, `${message}\n`);
    return 1;
  }
}

// --- context command ---

export async function contextCommand(args: string[], io: CliIO): Promise<number> {
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

// --- compact command ---

export async function compactCommand(args: string[], io: CliIO): Promise<number> {
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

// --- interactive session helpers ---

export async function handleTranscript(io: CliIO, thread: Thread, line: string): Promise<void> {
  const [, subcommand, ...queryParts] = line.split(/\s+/);
  if (subcommand === "search") {
    await printTranscriptSearchResults(io, await thread.searchTranscript(queryParts.join(" ")));
    return;
  }
  await printTranscriptInfo(io, await thread.transcript());
}

export async function handleContext(io: CliIO, thread: Thread, line: string): Promise<void> {
  const prompt = line.split(/\s+/).slice(1).join(" ").trim();
  if (!prompt) {
    await write(io.stdout, `Usage: ${slashCommandUsage("context")}\n`);
    return;
  }
  await printContextPreview(io, await thread.context(prompt));
}

export async function handleCompact(io: CliIO, thread: Thread): Promise<void> {
  const result = await thread.compact();
  await printCompactResult(io, result);
}

// --- arg parsing ---

interface TranscriptParsedArgs {
  sessionId?: string;
  query?: string;
  json: boolean;
  jsonl: boolean;
  subcommand?: "export" | "search";
}

function parseTranscriptArgs(args: string[]): TranscriptParsedArgs {
  let json = false;
  let jsonl = false;
  const positional: string[] = [];

  for (const arg of args) {
    if (arg === "--json") { json = true; continue; }
    if (arg === "--jsonl") { jsonl = true; continue; }
    positional.push(arg);
  }

  const [first, second, ...rest] = positional;

  // transcript export <session-id>
  if (first === "export") {
    return { sessionId: second?.trim() || undefined, json: false, jsonl, subcommand: "export" };
  }

  // transcript search <query>
  if (first === "search") {
    return { query: [second, ...rest].join(" ").trim(), json, jsonl: false, subcommand: "search" };
  }

  // transcript [session-id] search <query>
  const sessionId = first?.trim() || undefined;
  if (second === "search") {
    return { sessionId, query: rest.join(" ").trim(), json, jsonl: false, subcommand: "search" };
  }

  return { sessionId, json, jsonl };
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

// --- printing ---

async function printSessions(io: CliIO, sessions: SessionListItem[]): Promise<void> {
  if (sessions.length === 0) {
    await write(io.stdout, "No sessions.\n");
    return;
  }
  const style = styleFromEnv(await readCliEnv(io));
  await writeSection(io, "Sessions", style);
  for (const session of sessions) {
    const marker = session.latest ? "latest" : "session";
    const lastEvent = session.lastEventTimestamp ? ` lastEvent=${session.lastEventTimestamp}` : "";
    await write(io.stdout, `${marker} ${session.sessionId} events=${session.eventCount}${lastEvent} transcript=${session.transcriptPath}\n`);
  }
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

async function printCompactResult(io: CliIO, result: Awaited<ReturnType<Thread["compact"]>>): Promise<void> {
  await write(io.stdout, `Compact summary ${result.path}\n`);
  await write(io.stdout, `Range: ${result.range}\n`);
  await write(io.stdout, `Events: ${result.eventCount}\n`);
}

function previewText(value: string): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length <= 140 ? normalized : `${normalized.slice(0, 137)}...`;
}

async function writeSection(io: CliIO, title: string, style: import("./format.js").CliStyle): Promise<void> {
  await write(io.stdout, `== ${heading(title, style)} ==\n`);
}
