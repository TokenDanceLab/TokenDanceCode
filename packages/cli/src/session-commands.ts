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

export async function sessionsCommand(io: CliIO): Promise<number> {
  try {
    await printSessions(io, await new TokenDanceCode().sessions({ storageRoot: io.cwd() }).list());
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await write(io.stderr, `${message}\n`);
    return 1;
  }
}

export async function transcriptCommand(args: string[], io: CliIO): Promise<number> {
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
