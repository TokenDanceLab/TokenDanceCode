import { Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import { createEventRenderer } from "../src/renderer.js";
import type { TDCodeEvent } from "@tokendance/code-sdk";

describe("CLI event renderer", () => {
  it("merges assistant deltas and keeps tool progress on its own line", async () => {
    const output = createOutput();
    const renderer = createEventRenderer({ stdout: output.stream });
    const events: TDCodeEvent[] = [
      { type: "assistant.delta", sessionId: "session-1", turnId: "turn-1", text: "hello" },
      { type: "assistant.delta", sessionId: "session-1", turnId: "turn-1", text: " world" },
      {
        type: "tool.started",
        sessionId: "session-1",
        turnId: "turn-1",
        call: { id: "call-1", name: "read_file", input: { path: "README.md" } }
      },
      {
        type: "tool.completed",
        sessionId: "session-1",
        turnId: "turn-1",
        result: { callId: "call-1", toolName: "read_file", ok: true, output: "done" }
      },
      {
        type: "turn.completed",
        sessionId: "session-1",
        turnId: "turn-1",
        finalResponse: "hello world",
        usage: { inputTokens: 2, outputTokens: 3 }
      }
    ];

    for (const event of events) {
      await renderer.render(event);
    }

    expect(output.text()).toMatch(/^hello world\ntool read_file started\n/);
    expect(output.text()).toContain("tool read_file completed: done duration=");
    expect(output.text()).toContain("usage input=2 output=3\n");
    expect(output.text()).not.toContain("hello\n world");
  });

  it("can highlight tool and usage lines with ANSI color when enabled", async () => {
    const output = createOutput();
    const renderer = createEventRenderer({ stdout: output.stream, color: true });
    const events: TDCodeEvent[] = [
      {
        type: "tool.started",
        sessionId: "session-1",
        turnId: "turn-1",
        call: { id: "call-1", name: "read_file", input: { path: "README.md" } }
      },
      {
        type: "tool.completed",
        sessionId: "session-1",
        turnId: "turn-1",
        result: { callId: "call-1", toolName: "read_file", ok: true, output: "done" }
      },
      {
        type: "turn.completed",
        sessionId: "session-1",
        turnId: "turn-1",
        finalResponse: "done",
        usage: { inputTokens: 2, outputTokens: 3 }
      }
    ];

    for (const event of events) {
      await renderer.render(event);
    }

    expect(output.text()).toContain("\u001B[36mtool\u001B[0m read_file started");
    expect(output.text()).toContain("\u001B[32mtool\u001B[0m read_file completed");
    expect(output.text()).toContain("\u001B[2musage input=2 output=3\u001B[0m");
  });
});

function createOutput(): { stream: Writable; text: () => string } {
  let value = "";
  return {
    stream: new Writable({
      write(chunk, _encoding, callback) {
        value += chunk.toString();
        callback();
      }
    }),
    text: () => value
  };
}
