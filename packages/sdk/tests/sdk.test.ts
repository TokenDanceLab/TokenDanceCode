import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
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
});
