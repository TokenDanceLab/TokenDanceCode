import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { readTranscript } from "./compact.js";
import type { SessionState, TranscriptEnvelope } from "./types.js";
import { FileTranscriptStore } from "./transcript.js";

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
  eventCount: number;
  lastEventTimestamp?: string;
  latest: boolean;
}

export class ResumeService {
  constructor(private readonly projectRoot: string) {}

  async latest(recentLimit = 20): Promise<ResumeResult> {
    const sessionIds = await this.listSessionIdsByMtime();
    const latestSessionId = sessionIds[0];
    if (!latestSessionId) {
      throw new Error("No resumable TokenDanceCode sessions found");
    }
    return this.byId(latestSessionId, recentLimit);
  }

  async byId(sessionId: string, recentLimit = 20): Promise<ResumeResult> {
    const store = new FileTranscriptStore({ rootDir: this.projectRoot });
    const session = await store.loadSession(sessionId);
    const sessionDir = store.sessionDir(sessionId);
    const transcript = await readTranscript(join(sessionDir, "transcript.jsonl"));
    return { session, sessionDir, recent: recoverRecentTranscript(transcript, recentLimit) };
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
          eventCount: transcript.length,
          lastEventTimestamp: transcript.at(-1)?.timestamp,
          latest: index === 0
        };
      })
    );
    return sessions;
  }

  private async listSessionIdsByMtime(): Promise<string[]> {
    return (await this.listSessionRowsByMtime()).map((row) => row.id);
  }

  private async listSessionRowsByMtime(): Promise<Array<{ id: string; mtimeMs: number }>> {
    const sessionsDir = join(this.projectRoot, ".tokendance", "sessions");
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
