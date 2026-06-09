import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  CompactService,
  FileTranscriptStore,
  ResumeService,
  recoverRecentTranscript,
  searchTranscript,
  type SessionState,
  type TranscriptEnvelope
} from "../src/index.js";

describe("CompactService", () => {
  it("writes deterministic compact summary metadata", async () => {
    const root = await mkdtemp(join(tmpdir(), "tdcode-compact-"));
    const session = createSession(root, "session-1");
    const store = new FileTranscriptStore({ rootDir: root });
    await store.initialize(session);
    await store.append({ type: "user.message", sessionId: session.id, turnId: "turn-1", message: { role: "user", content: "hi" } });
    await store.append({
      type: "turn.completed",
      sessionId: session.id,
      turnId: "turn-1",
      finalResponse: "done"
    });

    const result = await new CompactService(store.sessionDir(session.id)).manualCompact();
    const second = await new CompactService(store.sessionDir(session.id)).manualCompact();
    const content = await readFile(result.path, "utf8");

    expect(result.eventCount).toBe(2);
    expect(result.path.endsWith("compact-0001.md")).toBe(true);
    expect(second.path.endsWith("compact-0002.md")).toBe(true);
    expect(content).toContain("# Compact Summary");
    expect(content).toContain("Range: seq 1-2");
    expect(content).toContain("Events: 2");
  });
});

describe("ResumeService", () => {
  it("loads latest session with recent recoverable transcript envelopes", async () => {
    const root = await mkdtemp(join(tmpdir(), "tdcode-resume-"));
    const oldSession = createSession(root, "old-session");
    const newSession = createSession(root, "new-session");
    const store = new FileTranscriptStore({ rootDir: root });
    await store.initialize(oldSession);
    await store.initialize(newSession);
    await store.append({ type: "tool.started", sessionId: newSession.id, turnId: "turn-1", call: { id: "call-1", name: "x", input: {} } });
    await store.append({ type: "user.message", sessionId: newSession.id, turnId: "turn-1", message: { role: "user", content: "resume me" } });
    await store.append({
      type: "turn.completed",
      sessionId: newSession.id,
      turnId: "turn-1",
      finalResponse: "done"
    });

    const result = await new ResumeService(root).latest();

    expect(result.session.id).toBe("new-session");
    expect(result.recent.map((envelope) => envelope.event.type)).toEqual(["user.message", "turn.completed"]);
  });

  it("lists available sessions with transcript metadata for AgentHub", async () => {
    const root = await mkdtemp(join(tmpdir(), "tdcode-resume-list-"));
    const oldSession = createSession(root, "old-session");
    const newSession = createSession(root, "new-session");
    const store = new FileTranscriptStore({ rootDir: root });
    await store.initialize(oldSession);
    await store.append({ type: "user.message", sessionId: oldSession.id, turnId: "turn-1", message: { role: "user", content: "old" } });
    await store.initialize(newSession);
    await store.append({ type: "user.message", sessionId: newSession.id, turnId: "turn-1", message: { role: "user", content: "new" } });
    await store.append({
      type: "turn.completed",
      sessionId: newSession.id,
      turnId: "turn-1",
      finalResponse: "done"
    });

    const sessions = await new ResumeService(root).listSessions();

    expect(sessions.map((session) => session.sessionId)).toEqual(["new-session", "old-session"]);
    expect(sessions[0]).toMatchObject({
      sessionId: "new-session",
      sessionDir: join(root, ".tokendance", "sessions", "new-session"),
      transcriptPath: join(root, ".tokendance", "sessions", "new-session", "transcript.jsonl"),
      eventCount: 2,
      latest: true
    });
    expect(sessions[0]?.lastEventTimestamp).toBeDefined();
    expect(sessions[1]).toMatchObject({
      sessionId: "old-session",
      eventCount: 1,
      latest: false
    });
  });

  it("filters unrecoverable in-flight tool events", () => {
    const recoverable = recoverRecentTranscript(
      [
        envelope("tool.started"),
        envelope("tool.permission"),
        envelope("tool.completed"),
        envelope("assistant.completed")
      ],
      10
    );

    expect(recoverable.map((item) => item.event.type)).toEqual(["tool.completed", "assistant.completed"]);
  });

  it("searches transcript envelopes through shared safe metadata", async () => {
    const root = await mkdtemp(join(tmpdir(), "tdcode-transcript-search-"));
    const session = createSession(root, "session-1");
    const store = new FileTranscriptStore({ rootDir: root });
    await store.initialize(session);
    await store.append({ type: "user.message", sessionId: session.id, turnId: "turn-1", message: { role: "user", content: "find core needle" } });
    await store.append({ type: "assistant.delta", sessionId: session.id, turnId: "turn-1", text: "core needle response" });
    await store.append({ type: "assistant.completed", sessionId: session.id, turnId: "turn-1", message: { role: "assistant", content: "needle final" } });
    await store.append({ type: "turn.completed", sessionId: session.id, turnId: "turn-1", finalResponse: "needle done" });

    const path = join(store.sessionDir(session.id), "transcript.jsonl");
    const matches = await searchTranscript(path, "needle", { limit: 10 });
    const limited = await searchTranscript(path, "needle", { limit: 1 });

    expect(matches).toEqual([
      expect.objectContaining({ sessionId: session.id, seq: 1, eventType: "user.message", turnId: "turn-1" }),
      expect.objectContaining({ sessionId: session.id, seq: 2, eventType: "assistant.delta", turnId: "turn-1" })
    ]);
    expect(matches[0]?.preview).toContain("needle");
    expect(JSON.stringify(matches)).not.toContain("finalResponse");
    expect(limited).toHaveLength(1);
  });

  it("searches a selected session transcript without resuming the thread", async () => {
    const root = await mkdtemp(join(tmpdir(), "tdcode-resume-search-"));
    const store = new FileTranscriptStore({ rootDir: root });
    const session = createSession(root, "session-search");
    await store.initialize(session);
    await store.append({ type: "user.message", sessionId: session.id, turnId: "turn-1", message: { role: "user", content: "resume needle" } });

    const matches = await new ResumeService(root).searchTranscript(session.id, "needle");

    expect(matches).toEqual([
      expect.objectContaining({
        sessionId: session.id,
        seq: 1,
        eventType: "user.message",
        turnId: "turn-1"
      })
    ]);
  });
});

function createSession(cwd: string, id: string): SessionState {
  return {
    id,
    cwd,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    permissionMode: "default",
    messages: []
  };
}

function envelope(type: TranscriptEnvelope["event"]["type"]): TranscriptEnvelope {
  return {
    version: 1,
    seq: 1,
    uuid: crypto.randomUUID(),
    timestamp: new Date().toISOString(),
    sessionId: "session-1",
    turnId: "turn-1",
    cwd: "C:/repo",
    event: fakeEvent(type)
  };
}

function fakeEvent(type: TranscriptEnvelope["event"]["type"]): TranscriptEnvelope["event"] {
  switch (type) {
    case "tool.started":
      return { type, sessionId: "session-1", turnId: "turn-1", call: { id: "call-1", name: "x", input: {} } };
    case "tool.permission":
      return {
        type,
        sessionId: "session-1",
        turnId: "turn-1",
        call: { id: "call-1", name: "x", input: {} },
        decision: { status: "allowed", reason: "test" }
      };
    case "tool.completed":
      return { type, sessionId: "session-1", turnId: "turn-1", result: { callId: "call-1", toolName: "x", ok: true } };
    case "assistant.completed":
      return { type, sessionId: "session-1", turnId: "turn-1", message: { role: "assistant", content: "done" } };
    default:
      throw new Error(`Unsupported fake event type: ${type}`);
  }
}
