import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FileTranscriptStore, type SessionState } from "@tokendance/code-core";
import { TokenDanceCode } from "../src/index.js";

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
});
