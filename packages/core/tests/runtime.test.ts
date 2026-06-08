import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AgentRuntime, FileTranscriptStore, MockProvider } from "../src/index.js";

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
});
