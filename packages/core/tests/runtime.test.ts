import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AgentRuntime, FileTranscriptStore, MockProvider, type ModelProvider, type TDMessage } from "../src/index.js";

describe("AgentRuntime", () => {
  it("runs a mock turn and emits a final response", async () => {
    const root = await mkdtemp(join(tmpdir(), "tdcode-core-"));
    const runtime = new AgentRuntime({
      cwd: root,
      provider: new MockProvider(),
      store: new FileTranscriptStore({ rootDir: root })
    });

    await runtime.initialize();
    const events = [];
    for await (const event of runtime.runTurn("hello")) {
      events.push(event);
    }

    expect(events.at(-1)).toMatchObject({
      type: "turn.completed",
      finalResponse: "Mock response: hello"
    });
    const turnIds = new Set(events.map((event) => ("turnId" in event ? event.turnId : undefined)));
    expect(turnIds.size).toBe(1);
  });

  it("routes registered tool calls through permission and transcript events", async () => {
    const root = await mkdtemp(join(tmpdir(), "tdcode-core-"));
    const runtime = new AgentRuntime({
      cwd: root,
      provider: new MockProvider(),
      store: new FileTranscriptStore({ rootDir: root })
    });

    await runtime.initialize();
    const types = [];
    for await (const event of runtime.runTurn("echo: from tool")) {
      types.push(event.type);
    }

    expect(types).toContain("tool.started");
    expect(types).toContain("tool.permission");
    expect(types).toContain("tool.completed");
    expect(types.at(-1)).toBe("turn.completed");
  });

  it("passes workspace context to the provider without persisting it as session messages", async () => {
    const root = await mkdtemp(join(tmpdir(), "tdcode-core-context-"));
    await writeFile(join(root, "AGENTS.md"), "Use repo agent rules.\n", "utf8");
    await writeFile(join(root, "README.md"), "Project readme context.\n", "utf8");
    const seenMessages: TDMessage[][] = [];
    const provider: ModelProvider = {
      async createTurn(request) {
        seenMessages.push(request.session.messages);
        return {
          assistantMessage: "context seen",
          toolCalls: []
        };
      }
    };
    const runtime = new AgentRuntime({
      cwd: root,
      provider,
      store: new FileTranscriptStore({ rootDir: root })
    });

    await runtime.initialize();
    for await (const _event of runtime.runTurn("inspect workspace")) {
      // Drain the event stream.
    }

    expect(seenMessages[0]?.[0]).toMatchObject({ role: "system" });
    expect(seenMessages[0]?.[0]?.content).toContain("Use repo agent rules.");
    expect(seenMessages[0]?.[0]?.content).toContain("Project readme context.");
    expect(seenMessages[0]?.at(-1)).toEqual({ role: "user", content: "inspect workspace" });
    expect(runtime.state.messages).toEqual([
      { role: "user", content: "inspect workspace" },
      { role: "assistant", content: "context seen" }
    ]);
  });

  it("emits a failed result for unknown tool calls", async () => {
    const root = await mkdtemp(join(tmpdir(), "tdcode-core-"));
    const runtime = new AgentRuntime({
      cwd: root,
      provider: new MockProvider(),
      store: new FileTranscriptStore({ rootDir: root })
    });

    await runtime.initialize();
    const events = [];
    for await (const event of runtime.runTurn("missingtool: from test")) {
      events.push(event);
    }

    expect(events).toContainEqual(expect.objectContaining({ type: "tool.started", call: expect.objectContaining({ name: "missing_tool" }) }));
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "tool.completed",
        result: expect.objectContaining({ toolName: "missing_tool", ok: false, error: "Unknown tool: missing_tool" })
      })
    );
  });

  it("writes transcript envelopes with stable resume metadata", async () => {
    const root = await mkdtemp(join(tmpdir(), "tdcode-core-"));
    const runtime = new AgentRuntime({
      cwd: root,
      provider: new MockProvider(),
      store: new FileTranscriptStore({ rootDir: root })
    });

    await runtime.initialize();
    for await (const _event of runtime.runTurn("hello")) {
      // Drain the event stream to force transcript writes.
    }

    const content = await readFile(
      join(root, ".tokendance", "sessions", runtime.state.id, "transcript.jsonl"),
      "utf8"
    );
    const envelope = JSON.parse(content.trim().split("\n")[0] ?? "{}");

    expect(envelope).toMatchObject({
      version: 1,
      sessionId: runtime.state.id,
      cwd: root,
      event: { type: "user.message" }
    });
    expect(envelope.uuid).toEqual(expect.any(String));
    expect(envelope.timestamp).toEqual(expect.any(String));
    expect(envelope.turnId).toEqual(expect.any(String));

    const secondEnvelope = JSON.parse(content.trim().split("\n")[1] ?? "{}");
    expect(secondEnvelope.parentUuid).toBe(envelope.uuid);
  });
});
