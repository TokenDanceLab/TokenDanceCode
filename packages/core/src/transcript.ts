import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { SessionState, TDCodeEvent, TranscriptStore } from "./types.js";

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
    const dir = this.sessionDir(sessionId);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "transcript.jsonl"), `${JSON.stringify({ ts: new Date().toISOString(), event })}\n`, {
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
