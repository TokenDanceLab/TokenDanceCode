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

  private async listSessionIdsByMtime(): Promise<string[]> {
    const sessionsDir = join(this.projectRoot, ".tokendance", "sessions");
    try {
      const entries = await readdir(sessionsDir, { withFileTypes: true });
      const rows = await Promise.all(
        entries
          .filter((entry) => entry.isDirectory())
          .map(async (entry) => ({
            id: entry.name,
            mtimeMs: (await stat(join(sessionsDir, entry.name, "session.json"))).mtimeMs
          }))
      );
      return rows.sort((a, b) => b.mtimeMs - a.mtimeMs).map((row) => row.id);
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
