import { execFile } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { FileTranscriptStore, type ModelProvider, type ModelTurnRequest, type ModelTurnResponse, type SessionState } from "@tokendance/code-core";
import { TokenDanceCode } from "../src/index.js";

const execFileAsync = promisify(execFile);

class WriteFileProvider implements ModelProvider {
  async createTurn(request: ModelTurnRequest): Promise<ModelTurnResponse> {
    if (request.toolResults.length > 0) {
      const result = request.toolResults.at(-1);
      return {
        assistantMessage: `write ${result?.ok ? "ok" : "failed"}`,
        toolCalls: []
      };
    }

    return {
      toolCalls: [
        {
          id: "write-approved",
          name: "write_file",
          input: { path: "approved.txt", content: "approved by AgentHub" }
        }
      ]
    };
  }
}

describe("TokenDanceCode SDK", () => {
  it("buffers a turn result for AgentHub callers", async () => {
    const root = await mkdtemp(join(tmpdir(), "tdcode-sdk-"));
    const client = new TokenDanceCode({ storageRoot: root });
    const thread = client.startThread({ workingDirectory: root });

    const turn = await thread.run("summarize repo");

    expect(turn.threadId).toBe(thread.id);
    expect(turn.finalResponse).toBe("Mock response: summarize repo");
    expect(turn.events.some((event) => event.type === "turn.completed")).toBe(true);
  });

  it("streams typed events", async () => {
    const root = await mkdtemp(join(tmpdir(), "tdcode-sdk-"));
    const client = new TokenDanceCode({ storageRoot: root });
    const thread = client.startThread({ workingDirectory: root });
    const streamed = await thread.runStreamed("hello");
    const types = [];

    for await (const event of streamed.events) {
      types.push(event.type);
    }

    expect(types).toEqual(["user.message", "assistant.delta", "assistant.completed", "turn.completed"]);
  });

  it("continues a thread across multiple turns", async () => {
    const root = await mkdtemp(join(tmpdir(), "tdcode-sdk-"));
    const client = new TokenDanceCode({ storageRoot: root });
    const thread = client.startThread({ workingDirectory: root });

    await thread.run("first");
    const second = await thread.run("second");

    expect(second.finalResponse).toBe("Mock response: second");
    expect(second.events.find((event) => event.type === "turn.completed")).toBeDefined();
  });

  it("exposes a read-only session snapshot for AgentHub callers", async () => {
    const root = await mkdtemp(join(tmpdir(), "tdcode-sdk-"));
    const client = new TokenDanceCode({ storageRoot: root });
    const thread = client.startThread({ workingDirectory: root });

    await thread.run("first");
    const snapshot = thread.state;
    snapshot.messages.push({ role: "user", content: "mutated outside" });
    const second = await thread.run("second");

    expect(snapshot.id).toBe(thread.id);
    expect(snapshot.messages.map((message) => message.content)).toContain("first");
    expect(second.finalResponse).toBe("Mock response: second");
    expect(thread.state.messages.map((message) => message.content)).not.toContain("mutated outside");
  });

  it("loads latest thread with recent transcript for AgentHub callers", async () => {
    const root = await mkdtemp(join(tmpdir(), "tdcode-sdk-"));
    const client = new TokenDanceCode({ storageRoot: root });
    const session: SessionState = {
      id: "session-load",
      cwd: root,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      permissionMode: "default",
      messages: []
    };
    const store = new FileTranscriptStore({ rootDir: root });
    await store.initialize(session);
    await store.append({ type: "user.message", sessionId: session.id, turnId: "turn-1", message: { role: "user", content: "hi" } });

    const thread = await client.loadLatestThread(root);

    expect(thread.id).toBe("session-load");
    expect(thread.recentTranscript).toHaveLength(1);
    expect(thread.recentTranscript[0]?.event.type).toBe("user.message");
  });

  it("resumes latest or selected thread through a single SDK helper", async () => {
    const root = await mkdtemp(join(tmpdir(), "tdcode-sdk-"));
    const client = new TokenDanceCode({ storageRoot: root });
    const oldSession: SessionState = {
      id: "session-old",
      cwd: root,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      permissionMode: "default",
      messages: []
    };
    const newSession: SessionState = { ...oldSession, id: "session-new" };
    const store = new FileTranscriptStore({ rootDir: root });
    await store.initialize(oldSession);
    await store.initialize(newSession);
    await store.append({ type: "user.message", sessionId: newSession.id, turnId: "turn-1", message: { role: "user", content: "latest" } });

    const latest = await client.resume({ storageRoot: root });
    const selected = await client.resume({ sessionId: "session-old", storageRoot: root });

    expect(latest.id).toBe("session-new");
    expect(latest.recentTranscript).toHaveLength(1);
    expect(selected.id).toBe("session-old");
  });

  it("compacts the current thread transcript for AgentHub callers", async () => {
    const root = await mkdtemp(join(tmpdir(), "tdcode-sdk-"));
    const client = new TokenDanceCode({ storageRoot: root });
    const thread = client.startThread({ workingDirectory: root });
    await thread.run("compact me");

    const compact = await thread.compact();

    expect(compact.summary).toContain("# Compact Summary");
    expect(compact.eventCount).toBeGreaterThan(0);
    await expect(readFile(compact.path, "utf8")).resolves.toContain("Events:");
  });

  it("compacts latest or selected thread through a single SDK helper", async () => {
    const root = await mkdtemp(join(tmpdir(), "tdcode-sdk-"));
    const client = new TokenDanceCode({ storageRoot: root });
    const oldThread = client.startThread({ id: "compact-old", workingDirectory: root });
    await oldThread.run("old compact");
    const newThread = client.startThread({ id: "compact-new", workingDirectory: root });
    await newThread.run("new compact");

    const latest = await client.compact({ storageRoot: root });
    const selected = await client.compact({ sessionId: "compact-old", storageRoot: root });

    expect(latest.path).toContain(join(".tokendance", "sessions", "compact-new", "compact"));
    expect(selected.path).toContain(join(".tokendance", "sessions", "compact-old", "compact"));
    expect(latest.eventCount).toBe(4);
    expect(selected.eventCount).toBe(4);
  });

  it("exposes transcript metadata for AgentHub callers", async () => {
    const root = await mkdtemp(join(tmpdir(), "tdcode-sdk-"));
    const client = new TokenDanceCode({ storageRoot: root });
    const thread = client.startThread({ workingDirectory: root });
    await thread.run("transcript me");

    const transcript = await thread.transcript();

    expect(transcript).toMatchObject({
      sessionId: thread.id,
      eventCount: 4,
      recentEventCount: 0
    });
    expect(transcript.sessionDir).toBe(join(root, ".tokendance", "sessions", thread.id));
    expect(transcript.transcriptPath).toBe(join(root, ".tokendance", "sessions", thread.id, "transcript.jsonl"));
  });

  it("searches transcript envelopes for AgentHub callers", async () => {
    const root = await mkdtemp(join(tmpdir(), "tdcode-sdk-"));
    const client = new TokenDanceCode({ storageRoot: root });
    const thread = client.startThread({ workingDirectory: root });
    await thread.run("find sdk needle");

    const matches = await thread.searchTranscript("needle");
    const none = await thread.searchTranscript("absent");

    expect(matches).toHaveLength(2);
    expect(matches[0]).toMatchObject({
      sessionId: thread.id,
      seq: 1,
      eventType: "user.message"
    });
    expect(matches[0]?.preview).toContain("needle");
    expect(matches[1]?.eventType).toBe("assistant.delta");
    expect(none).toEqual([]);
  });

  it("manages memory through the SDK boundary for AgentHub callers", async () => {
    const root = await mkdtemp(join(tmpdir(), "tdcode-sdk-"));
    const client = new TokenDanceCode();
    const memory = client.memory({ projectRoot: root, homeDir: join(root, "home") });

    await memory.add("project", "Keep SDK APIs stable.");
    await memory.add("global", "Prefer concise output.");

    expect(await memory.list("project")).toEqual(["Keep SDK APIs stable."]);
    expect(await memory.list("global")).toEqual(["Prefer concise output."]);

    await memory.delete("project", 0);

    expect(await memory.list("project")).toEqual([]);
    await expect(readFile(join(root, ".tokendance", "memory", "project.md"), "utf8")).resolves.toBe("");
  });

  it("executes registered tools through the SDK boundary for AgentHub callers", async () => {
    const root = await initRepo();
    const client = new TokenDanceCode();
    const tools = client.tools({ workingDirectory: root });
    await writeFile(join(root, "notes.txt"), "old\nnew TODO\n", "utf8");

    const status = await tools.execute("git_status");
    const diff = await tools.execute("git_diff");
    const review = await tools.execute("git_review");
    const quality = await tools.execute("quality_gate", { command: "Get-ChildItem -Name", timeout: 5 }, { permissionMode: "yolo" });

    expect(status).toMatchObject({ ok: true });
    expect(JSON.stringify(status.output)).toContain("M notes.txt");
    expect(diff).toMatchObject({ ok: true });
    expect(JSON.stringify(diff.output)).toContain("+new TODO");
    expect(review).toMatchObject({
      ok: true,
      output: { findings: [{ severity: "medium", message: "Diff adds TODO text that may need a tracked follow-up." }] }
    });
    expect(quality).toMatchObject({ ok: true, output: { passed: true } });
  });

  it("lets AgentHub approve a write tool before execution", async () => {
    const root = await mkdtemp(join(tmpdir(), "tdcode-sdk-"));
    const approvals: string[] = [];
    const client = new TokenDanceCode({
      storageRoot: root,
      provider: new WriteFileProvider(),
      approvalCallback(request) {
        approvals.push(`${request.tool.name}:${request.decision.status}`);
        return true;
      }
    });
    const thread = client.startThread({ workingDirectory: root, permissionMode: "default" });

    const turn = await thread.run("write approved file");

    expect(approvals).toEqual(["write_file:requires_approval"]);
    expect(turn.finalResponse).toBe("write ok");
    await expect(readFile(join(root, "approved.txt"), "utf8")).resolves.toBe("approved by AgentHub");
    expect(turn.events).toContainEqual(
      expect.objectContaining({
        type: "tool.permission",
        decision: expect.objectContaining({ status: "allowed" })
      })
    );
  });

  it("lets AgentHub deny a write tool before execution", async () => {
    const root = await mkdtemp(join(tmpdir(), "tdcode-sdk-"));
    const client = new TokenDanceCode({
      storageRoot: root,
      provider: new WriteFileProvider(),
      approvalCallback() {
        return false;
      }
    });
    const thread = client.startThread({ workingDirectory: root, permissionMode: "default" });

    const turn = await thread.run("write denied file");

    expect(turn.finalResponse).toBe("write failed");
    await expect(readFile(join(root, "approved.txt"), "utf8")).rejects.toThrow();
    expect(turn.events).toContainEqual(
      expect.objectContaining({
        type: "tool.permission",
        decision: expect.objectContaining({ status: "denied" })
      })
    );
  });

  it("uses SDK env when constructing configured providers", async () => {
    const root = await mkdtemp(join(tmpdir(), "tdcode-sdk-"));
    const client = new TokenDanceCode({
      storageRoot: root,
      provider: { type: "openai-responses", model: "gpt-test" },
      env: {}
    });
    const thread = client.startThread({ workingDirectory: root });

    await expect(thread.run("hello")).rejects.toThrow("OPENAI_API_KEY is not configured");
  });

  it("forwards runtime events to an AgentHub event sink", async () => {
    const root = await mkdtemp(join(tmpdir(), "tdcode-sdk-"));
    const received: string[] = [];
    const client = new TokenDanceCode({
      storageRoot: root,
      eventSink(event) {
        received.push(event.type);
      }
    });
    const thread = client.startThread({ workingDirectory: root });

    await thread.run("stream to sink");

    expect(received).toEqual(["user.message", "assistant.delta", "assistant.completed", "turn.completed"]);
  });
});

async function initRepo(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "tdcode-sdk-git-"));
  await execFileAsync("git", ["init"], { cwd: root });
  await execFileAsync("git", ["config", "user.email", "test@example.com"], { cwd: root });
  await execFileAsync("git", ["config", "user.name", "TokenDance Test"], { cwd: root });
  await writeFile(join(root, "notes.txt"), "old\n", "utf8");
  await execFileAsync("git", ["add", "."], { cwd: root });
  await execFileAsync("git", ["commit", "-m", "initial"], { cwd: root });
  return root;
}
