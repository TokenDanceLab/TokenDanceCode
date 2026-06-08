import { mkdir, readFile, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { SessionState, TDCodeEvent, TranscriptEnvelope, TranscriptStore } from "./types.js";

export interface FileTranscriptStoreOptions {
  rootDir: string;
}

export class FileTranscriptStore implements TranscriptStore {
  private readonly cwdBySession = new Map<string, string>();
  private readonly lastUuidBySession = new Map<string, string>();

  constructor(private readonly options: FileTranscriptStoreOptions) {}

  async initialize(session: SessionState): Promise<void> {
    this.cwdBySession.set(session.id, session.cwd);
    const dir = this.sessionDir(session.id);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "session.json"), `${JSON.stringify(session, null, 2)}\n`, "utf8");
  }

  async append(event: TDCodeEvent): Promise<void> {
    const sessionId = "sessionId" in event ? event.sessionId : event.session.id;
    if ("session" in event) {
      this.cwdBySession.set(sessionId, event.session.cwd);
    }
    const envelope: TranscriptEnvelope = {
      version: 1,
      uuid: randomUUID(),
      parentUuid: this.lastUuidBySession.get(sessionId),
      timestamp: new Date().toISOString(),
      sessionId,
      turnId: "turnId" in event ? event.turnId : undefined,
      cwd: this.cwdBySession.get(sessionId) ?? this.options.rootDir,
      event
    };
    this.lastUuidBySession.set(sessionId, envelope.uuid);
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
