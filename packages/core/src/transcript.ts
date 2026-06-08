import { mkdir, readFile, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { SessionState, TDCodeEvent, TranscriptEnvelope, TranscriptStore } from "./types.js";

export interface FileTranscriptStoreOptions {
  rootDir: string;
}

export class FileTranscriptStore implements TranscriptStore {
  constructor(private readonly options: FileTranscriptStoreOptions) {}

  async initialize(session: SessionState): Promise<void> {
    const dir = this.sessionDir(session.id);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "session.json"), `${JSON.stringify(session, null, 2)}\n`, "utf8");
  }

  async append(event: TDCodeEvent): Promise<void> {
    const sessionId = "sessionId" in event ? event.sessionId : event.session.id;
    const envelope: TranscriptEnvelope = {
      version: 1,
      uuid: randomUUID(),
      timestamp: new Date().toISOString(),
      sessionId,
      turnId: "turnId" in event ? event.turnId : undefined,
      event
    };
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

  sessionDir(sessionId: string): string {
    return join(this.options.rootDir, ".tokendance", "sessions", sessionId);
  }
}
