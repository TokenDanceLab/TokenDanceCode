import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { readTranscript } from "./transcript.js";
import type { SessionState, TranscriptEnvelope } from "./types.js";

export interface CompactResult {
  path: string;
  summary: string;
  eventCount: number;
  range: string;
}

export class CompactService {
  constructor(private readonly sessionDir: string) {}

  async manualCompact(): Promise<CompactResult> {
    const envelopes = await readTranscript(join(this.sessionDir, "transcript.jsonl"));
    const compactDir = join(this.sessionDir, "compact");
    await mkdir(compactDir, { recursive: true });
    const path = join(compactDir, `compact-${String((await nextCompactIndex(compactDir))).padStart(4, "0")}.md`);
    const range =
      envelopes.length > 0
        ? `seq ${envelopes[0]?.seq ?? 1}-${envelopes.at(-1)?.seq ?? envelopes.length}`
        : "seq none";
    const summary = buildCompactSummary(envelopes, range);
    await writeFile(path, `${summary}\n`, "utf8");
    await persistCompactSummary(this.sessionDir, summary);
    return { path, summary, eventCount: envelopes.length, range };
  }
}

async function persistCompactSummary(sessionDir: string, summary: string): Promise<void> {
  const sessionPath = join(sessionDir, "session.json");
  try {
    const session = JSON.parse(await readFile(sessionPath, "utf8")) as SessionState;
    await writeFile(
      sessionPath,
      `${JSON.stringify(
        {
          ...session,
          compactSummary: summary,
          updatedAt: new Date().toISOString()
        },
        null,
        2
      )}\n`,
      "utf8"
    );
  } catch {
    // Compact can still be used against transcript-only directories.
  }
}

function buildCompactSummary(envelopes: TranscriptEnvelope[], range: string): string {
  const lines = ["# Compact Summary", "", `Range: ${range}`, `Events: ${envelopes.length}`];
  const latestTurnId = [...envelopes].reverse().find((envelope) => envelope.turnId)?.turnId;
  const lastUserRequest = [...envelopes].reverse().find((envelope) => envelope.event.type === "user.message")?.event;
  const lastAssistantResponse = [...envelopes].reverse().find((envelope) => envelope.event.type === "assistant.completed")?.event;

  if (latestTurnId || lastUserRequest?.type === "user.message" || lastAssistantResponse?.type === "assistant.completed") {
    lines.push("", "## Recovery Notes");
    if (latestTurnId) {
      lines.push(`- Latest turn: ${latestTurnId}`);
    }
    if (lastUserRequest?.type === "user.message") {
      lines.push(`- Last user request: ${previewText(lastUserRequest.message.content, 240)}`);
    }
    if (lastAssistantResponse?.type === "assistant.completed") {
      lines.push(`- Last assistant response: ${previewText(lastAssistantResponse.message.content, 240)}`);
    }
  }

  const snippets = envelopes.map(transcriptSnippet).filter((snippet): snippet is string => snippet !== undefined).slice(-8);
  if (snippets.length > 0) {
    lines.push("", "## Recent Recoverable Transcript", ...snippets.map((snippet) => `- ${snippet}`));
  }

  return lines.join("\n");
}

function transcriptSnippet(envelope: TranscriptEnvelope): string | undefined {
  switch (envelope.event.type) {
    case "user.message":
      return `seq ${envelope.seq} user: ${previewText(envelope.event.message.content, 200)}`;
    case "assistant.completed":
      return `seq ${envelope.seq} assistant: ${previewText(envelope.event.message.content, 200)}`;
    case "tool.completed":
      return `seq ${envelope.seq} tool ${envelope.event.result.toolName}: ${envelope.event.result.ok ? "ok" : "failed"} ${previewToolResult(envelope.event.result.output ?? envelope.event.result.error)}`.trim();
    case "turn.completed":
      return `seq ${envelope.seq} turn.completed: ${previewText(envelope.event.finalResponse, 200)}`;
    case "turn.failed":
      return `seq ${envelope.seq} turn.failed: ${previewText(envelope.event.error, 200)}`;
    default:
      return undefined;
  }
}

function previewToolResult(value: unknown): string {
  if (value === undefined) {
    return "";
  }
  return previewText(typeof value === "string" ? value : JSON.stringify(value), 160);
}

function previewText(text: string, maxCharacters: number): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxCharacters) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(0, maxCharacters - 24))} ...[truncated]`;
}

async function nextCompactIndex(compactDir: string): Promise<number> {
  const entries = await readdir(compactDir);
  const indexes = entries
    .map((entry) => /^compact-(\d+)\.md$/.exec(entry)?.[1])
    .filter((value): value is string => value !== undefined)
    .map((value) => Number.parseInt(value, 10))
    .filter(Number.isFinite);
  return indexes.length > 0 ? Math.max(...indexes) + 1 : 1;
}

export { readTranscript } from "./transcript.js";
