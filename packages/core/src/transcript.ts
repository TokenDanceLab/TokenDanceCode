import { mkdir, readFile, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { SessionState, TDCodeEvent, TranscriptEnvelope, TranscriptStore } from "./types.js";

export interface FileTranscriptStoreOptions {
  rootDir: string;
}

export interface TranscriptSearchOptions {
  limit?: number;
}

export interface TranscriptSearchResult {
  sessionId: string;
  seq: number;
  eventType: TDCodeEvent["type"];
  timestamp: string;
  turnId?: string;
  preview: string;
}

export class FileTranscriptStore implements TranscriptStore {
  private readonly cwdBySession = new Map<string, string>();
  private readonly lastUuidBySession = new Map<string, string>();
  private readonly nextSeqBySession = new Map<string, number>();

  constructor(private readonly options: FileTranscriptStoreOptions) {}

  async initialize(session: SessionState): Promise<void> {
    this.cwdBySession.set(session.id, session.cwd);
    const dir = this.sessionDir(session.id);
    await mkdir(dir, { recursive: true });
    await this.hydrateSessionCounters(session.id);
    await this.saveSession(session);
  }

  async append(event: TDCodeEvent): Promise<void> {
    const sessionId = "sessionId" in event ? event.sessionId : event.session.id;
    if ("session" in event) {
      this.cwdBySession.set(sessionId, event.session.cwd);
    }
    await this.hydrateSessionCounters(sessionId);
    const seq = this.nextSeqBySession.get(sessionId) ?? 1;
    const envelope: TranscriptEnvelope = {
      version: 1,
      seq,
      uuid: randomUUID(),
      parentUuid: this.lastUuidBySession.get(sessionId),
      timestamp: new Date().toISOString(),
      sessionId,
      turnId: "turnId" in event ? event.turnId : undefined,
      cwd: this.cwdBySession.get(sessionId) ?? this.options.rootDir,
      event
    };
    this.lastUuidBySession.set(sessionId, envelope.uuid);
    this.nextSeqBySession.set(sessionId, seq + 1);
    const dir = this.sessionDir(sessionId);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "transcript.jsonl"), `${JSON.stringify(envelope)}\n`, {
      encoding: "utf8",
      flag: "a"
    });
  }

  async loadSession(sessionId: string): Promise<SessionState> {
    const content = await readFile(join(this.sessionDir(sessionId), "session.json"), "utf8");
    return JSON.parse(content) as SessionState;
  }

  async saveSession(session: SessionState): Promise<void> {
    const dir = this.sessionDir(session.id);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "session.json"), `${JSON.stringify(session, null, 2)}\n`, "utf8");
  }

  sessionDir(sessionId: string): string {
    return join(this.options.rootDir, ".tokendance", "sessions", sessionId);
  }

  private async hydrateSessionCounters(sessionId: string): Promise<void> {
    if (this.nextSeqBySession.has(sessionId)) {
      return;
    }
    try {
      const content = await readFile(join(this.sessionDir(sessionId), "transcript.jsonl"), "utf8");
      const envelopes = content
        .split(/\r?\n/)
        .filter((line) => line.trim().length > 0)
        .map((line) => JSON.parse(line) as TranscriptEnvelope);
      const last = envelopes.at(-1);
      this.nextSeqBySession.set(sessionId, (last?.seq ?? envelopes.length) + 1);
      if (last?.uuid) {
        this.lastUuidBySession.set(sessionId, last.uuid);
      }
      if (last?.cwd) {
        this.cwdBySession.set(sessionId, last.cwd);
      }
    } catch {
      this.nextSeqBySession.set(sessionId, 1);
    }
  }
}

export async function readTranscript(path: string): Promise<TranscriptEnvelope[]> {
  try {
    const content = await readFile(path, "utf8");
    return content
      .split(/\r?\n/)
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as TranscriptEnvelope);
  } catch {
    return [];
  }
}

export async function searchTranscript(
  path: string,
  query: string,
  options: TranscriptSearchOptions = {}
): Promise<TranscriptSearchResult[]> {
  const normalizedQuery = query.trim().toLowerCase();
  const limit = options.limit ?? 20;
  if (!normalizedQuery || limit <= 0) {
    return [];
  }

  const envelopes = await readTranscript(path);
  return envelopes
    .filter((envelope) => isSearchableTranscriptEvent(envelope.event))
    .map((envelope) => ({ envelope, serialized: JSON.stringify(envelope.event) }))
    .filter(({ serialized }) => serialized.toLowerCase().includes(normalizedQuery))
    .slice(0, limit)
    .map(({ envelope, serialized }) => ({
      sessionId: envelope.sessionId,
      seq: envelope.seq,
      eventType: envelope.event.type,
      timestamp: envelope.timestamp,
      turnId: envelope.turnId,
      preview: previewMatch(serialized, normalizedQuery)
    }));
}

function isSearchableTranscriptEvent(event: TDCodeEvent): boolean {
  return event.type !== "assistant.completed" && event.type !== "turn.completed";
}

function previewMatch(serialized: string, normalizedQuery: string): string {
  const index = serialized.toLowerCase().indexOf(normalizedQuery);
  if (index < 0) {
    return serialized.slice(0, 120);
  }
  const start = Math.max(0, index - 40);
  const end = Math.min(serialized.length, index + normalizedQuery.length + 80);
  const prefix = start > 0 ? "..." : "";
  const suffix = end < serialized.length ? "..." : "";
  return `${prefix}${serialized.slice(start, end)}${suffix}`;
}
