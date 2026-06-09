import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import type { SessionState, TranscriptEnvelope } from "./types.js";
import { FileTranscriptStore, readTranscript, searchTranscript, type TranscriptSearchOptions, type TranscriptSearchResult } from "./transcript.js";

export interface ResumeResult {
  session: SessionState;
  sessionDir: string;
  recent: TranscriptEnvelope[];
}

export interface SessionListItem {
  sessionId: string;
  sessionDir: string;
  transcriptPath: string;
  createdAt: string;
  updatedAt: string;
  cwd: string;
  permissionMode: SessionState["permissionMode"];
  messageCount: number;
  eventCount: number;
  lastEventTimestamp?: string;
  latest: boolean;
}

export interface SessionExport extends SessionListItem {
  session: SessionState;
  transcript: TranscriptEnvelope[];
  transcriptJsonl: string;
}

export interface SessionPruneOptions {
  keepLatest?: number;
  olderThanMs?: number;
  now?: Date | string;
}

export interface SessionPruneCandidate extends SessionListItem {
  reason: "exceeds_keep_latest" | "older_than";
  ageMs: number;
  rank: number;
}

export type ResumeDiagnosticReason = "ok" | "no_sessions" | "session_not_found" | "session_unreadable";

export interface ResumeDiagnostic {
  ok: boolean;
  reason: ResumeDiagnosticReason;
  message: string;
  storageRoot: string;
  sessionsDir: string;
  requestedSessionId?: string;
  selectedSessionId?: string;
  availableSessionIds: string[];
}

export class ResumeError extends Error {
  readonly diagnostic: ResumeDiagnostic;
  readonly code?: string;

  constructor(diagnostic: ResumeDiagnostic, cause?: unknown) {
    super(diagnostic.message, cause === undefined ? undefined : { cause });
    this.name = "ResumeError";
    this.diagnostic = diagnostic;
    if (diagnostic.reason === "no_sessions" || diagnostic.reason === "session_not_found") {
      this.code = "ENOENT";
    }
  }
}

export class ResumeService {
  constructor(private readonly projectRoot: string) {}

  async latest(recentLimit = 20): Promise<ResumeResult> {
    const diagnostic = await this.diagnose();
    if (!diagnostic.ok || !diagnostic.selectedSessionId) {
      throw new ResumeError(diagnostic);
    }
    return this.byId(diagnostic.selectedSessionId, recentLimit);
  }

  async byId(sessionId: string, recentLimit = 20): Promise<ResumeResult> {
    const store = new FileTranscriptStore({ rootDir: this.projectRoot });
    const diagnostic = await this.diagnose(sessionId);
    if (!diagnostic.ok) {
      throw new ResumeError(diagnostic);
    }
    try {
      const session = await store.loadSession(sessionId);
      const sessionDir = store.sessionDir(sessionId);
      const transcript = await readTranscript(join(sessionDir, "transcript.jsonl"));
      return { session, sessionDir, recent: recoverRecentTranscript(transcript, recentLimit) };
    } catch (error) {
      throw new ResumeError(
        {
          ...diagnostic,
          ok: false,
          reason: "session_unreadable",
          message: `Unable to read TokenDanceCode session ${sessionId}`
        },
        error
      );
    }
  }

  async listSessions(): Promise<SessionListItem[]> {
    const rows = await this.listSessionRowsByMtime();
    const store = new FileTranscriptStore({ rootDir: this.projectRoot });
    const sessions = await Promise.all(
      rows.map(async (row, index) => {
        const session = await store.loadSession(row.id);
        const sessionDir = store.sessionDir(row.id);
        const transcriptPath = join(sessionDir, "transcript.jsonl");
        const transcript = await readTranscript(transcriptPath);
        return {
          sessionId: session.id,
          sessionDir,
          transcriptPath,
          createdAt: session.createdAt,
          updatedAt: session.updatedAt,
          cwd: session.cwd,
          permissionMode: session.permissionMode,
          messageCount: session.messages.length,
          eventCount: transcript.length,
          lastEventTimestamp: transcript.at(-1)?.timestamp,
          latest: index === 0
        };
      })
    );
    return sessions;
  }

  async searchTranscript(sessionId: string, query: string, options: TranscriptSearchOptions = {}): Promise<TranscriptSearchResult[]> {
    const store = new FileTranscriptStore({ rootDir: this.projectRoot });
    return searchTranscript(join(store.sessionDir(sessionId), "transcript.jsonl"), query, options);
  }

  async exportSession(sessionId: string): Promise<SessionExport> {
    const store = new FileTranscriptStore({ rootDir: this.projectRoot });
    const result = await this.byId(sessionId, 0);
    const sessionDir = store.sessionDir(sessionId);
    const transcriptPath = join(sessionDir, "transcript.jsonl");
    const transcript = await readTranscript(transcriptPath);
    const transcriptJsonl = await readTranscriptJsonl(transcriptPath);
    const latestSessionId = (await this.listSessionRowsByMtime())[0]?.id;

    return {
      sessionId,
      sessionDir,
      transcriptPath,
      createdAt: result.session.createdAt,
      updatedAt: result.session.updatedAt,
      cwd: result.session.cwd,
      permissionMode: result.session.permissionMode,
      messageCount: result.session.messages.length,
      eventCount: transcript.length,
      lastEventTimestamp: transcript.at(-1)?.timestamp,
      latest: latestSessionId === sessionId,
      session: result.session,
      transcript,
      transcriptJsonl
    };
  }

  async pruneCandidates(options: SessionPruneOptions = {}): Promise<SessionPruneCandidate[]> {
    const keepLatest = Math.max(0, options.keepLatest ?? Number.POSITIVE_INFINITY);
    const olderThanMs = options.olderThanMs;
    const nowMs = normalizeNow(options.now).getTime();
    const sessions = await this.listSessions();
    const candidates = new Map<string, SessionPruneCandidate>();

    sessions.forEach((session, index) => {
      const updatedAtMs = new Date(session.updatedAt).getTime();
      const ageMs = Number.isFinite(updatedAtMs) ? Math.max(0, nowMs - updatedAtMs) : 0;
      if (index >= keepLatest) {
        candidates.set(session.sessionId, {
          ...session,
          reason: "exceeds_keep_latest",
          ageMs,
          rank: index + 1
        });
        return;
      }
      if (olderThanMs !== undefined && ageMs >= olderThanMs) {
        candidates.set(session.sessionId, {
          ...session,
          reason: "older_than",
          ageMs,
          rank: index + 1
        });
      }
    });

    return [...candidates.values()];
  }

  async diagnose(sessionId?: string): Promise<ResumeDiagnostic> {
    const sessionsDir = this.sessionsDir();
    const rows = await this.listSessionRowsByMtime();
    const availableSessionIds = rows.map((row) => row.id);
    const selectedSessionId = sessionId ?? availableSessionIds[0];

    if (!selectedSessionId) {
      return {
        ok: false,
        reason: "no_sessions",
        message: "No resumable TokenDanceCode sessions found",
        storageRoot: this.projectRoot,
        sessionsDir,
        requestedSessionId: sessionId,
        availableSessionIds
      };
    }

    if (sessionId && !availableSessionIds.includes(sessionId)) {
      return {
        ok: false,
        reason: "session_not_found",
        message: `TokenDanceCode session ${sessionId} was not found`,
        storageRoot: this.projectRoot,
        sessionsDir,
        requestedSessionId: sessionId,
        selectedSessionId,
        availableSessionIds
      };
    }

    return {
      ok: true,
      reason: "ok",
      message: `TokenDanceCode session ${selectedSessionId} is resumable`,
      storageRoot: this.projectRoot,
      sessionsDir,
      requestedSessionId: sessionId,
      selectedSessionId,
      availableSessionIds
    };
  }

  private async listSessionRowsByMtime(): Promise<Array<{ id: string; mtimeMs: number }>> {
    const sessionsDir = this.sessionsDir();
    try {
      const entries = await readdir(sessionsDir, { withFileTypes: true });
      const rows = await Promise.all(
        entries
          .filter((entry) => entry.isDirectory())
          .map(async (entry) => {
            try {
              return {
                id: entry.name,
                mtimeMs: (await stat(join(sessionsDir, entry.name, "session.json"))).mtimeMs
              };
            } catch {
              return undefined;
            }
          })
      );
      return rows
        .filter((row): row is { id: string; mtimeMs: number } => row !== undefined)
        .sort((a, b) => b.mtimeMs - a.mtimeMs);
    } catch {
      return [];
    }
  }

  private sessionsDir(): string {
    return join(this.projectRoot, ".tokendance", "sessions");
  }
}

export function recoverRecentTranscript(envelopes: TranscriptEnvelope[], recentLimit: number): TranscriptEnvelope[] {
  const valid = envelopes.filter((envelope) => envelope.version === 1 && isRecoverableEvent(envelope));
  if (recentLimit <= 0) {
    return [];
  }
  return valid.slice(-recentLimit);
}

function isRecoverableEvent(envelope: TranscriptEnvelope): boolean {
  if (envelope.event.type === "tool.started" || envelope.event.type === "tool.permission") {
    return false;
  }
  return true;
}

async function readTranscriptJsonl(path: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return "";
  }
}

function normalizeNow(now: Date | string | undefined): Date {
  if (now instanceof Date) {
    return now;
  }
  if (typeof now === "string") {
    return new Date(now);
  }
  return new Date();
}
