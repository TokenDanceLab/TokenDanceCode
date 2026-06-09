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
    expect(output.text()).toContain("usage input=2 output=3 total=5\n");
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
    expect(output.text()).toContain("usage input=\u001B[36m2\u001B[0m output=\u001B[36m3\u001B[0m total=\u001B[36m5\u001B[0m");
  });

  it("renders permission risk, tool errors, and usage totals as stable plain text", async () => {
    const output = createOutput();
    const renderer = createEventRenderer({ stdout: output.stream });
    const reason = "mode=default tool=run_powershell risk=shell action=approval_required: default mode requires approval";
    const events: TDCodeEvent[] = [
      {
        type: "tool.permission",
        sessionId: "session-1",
        turnId: "turn-1",
        call: { id: "call-1", name: "run_powershell", input: { command: "pnpm verify" } },
        decision: { status: "requires_approval", reason }
      },
      {
        type: "tool.completed",
        sessionId: "session-1",
        turnId: "turn-1",
        result: {
          callId: "call-1",
          toolName: "run_powershell",
          ok: false,
          error: reason,
          safetyEvidence: {
            toolName: "run_powershell",
            source: "permission_engine",
            status: "requires_approval",
            reason,
            decision: { status: "requires_approval", reason }
          }
        }
      },
      {
        type: "turn.completed",
        sessionId: "session-1",
        turnId: "turn-1",
        finalResponse: "",
        usage: { inputTokens: 7, outputTokens: 11 }
      }
    ];

    for (const event of events) {
      await renderer.render(event);
    }

    expect(output.text()).toContain(`permission requires_approval [risk=shell] ${reason}\n`);
    expect(output.text()).toContain(`tool run_powershell failed [risk=shell source=permission_engine]: ${reason}\n`);
    expect(output.text()).toContain("usage input=7 output=11 total=18\n");
    expect(output.text()).not.toContain("\u001B[");
  });

  it("highlights permission status, tool risk, tool failure, and usage numbers when color is enabled", async () => {
    const output = createOutput();
    const renderer = createEventRenderer({ stdout: output.stream, color: true });
    const reason = "mode=safe tool=write_file risk=write action=denied: safe mode only allows read-only tools";
    const events: TDCodeEvent[] = [
      {
        type: "tool.permission",
        sessionId: "session-1",
        turnId: "turn-1",
        call: { id: "call-1", name: "write_file", input: { path: "README.md", content: "x" } },
        decision: { status: "denied", reason }
      },
      {
        type: "tool.completed",
        sessionId: "session-1",
        turnId: "turn-1",
        result: {
          callId: "call-1",
          toolName: "write_file",
          ok: false,
          error: reason,
          safetyEvidence: {
            toolName: "write_file",
            source: "permission_engine",
            status: "denied",
            reason,
            decision: { status: "denied", reason }
          }
        }
      },
      {
        type: "turn.completed",
        sessionId: "session-1",
        turnId: "turn-1",
        finalResponse: "",
        usage: { inputTokens: 7, outputTokens: 11 }
      }
    ];

    for (const event of events) {
      await renderer.render(event);
    }

    expect(output.text()).toContain("permission \u001B[31mdenied\u001B[0m [risk=\u001B[33mwrite\u001B[0m]");
    expect(output.text()).toContain("\u001B[31mfailed\u001B[0m [risk=\u001B[33mwrite\u001B[0m source=\u001B[2mpermission_engine\u001B[0m]");
    expect(output.text()).toContain("usage input=\u001B[36m7\u001B[0m output=\u001B[36m11\u001B[0m total=\u001B[36m18\u001B[0m");
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
