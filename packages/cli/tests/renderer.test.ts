import { Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import { createEventRenderer } from "../src/renderer.js";
import type { TDCodeEvent } from "@tokendance/code-sdk";

describe("CLI event renderer", () => {
  it("renders tool-specific scrollback summaries and multi-line failure blocks without ANSI by default", async () => {
    const output = createOutput();
    const renderer = createEventRenderer({ stdout: output.stream });
    const reason = "mode=default tool=run_powershell risk=shell action=approval_required: default mode requires approval";
    const events: TDCodeEvent[] = [
      {
        type: "tool.started",
        sessionId: "session-1",
        turnId: "turn-1",
        call: { id: "call-1", name: "run_powershell", input: { command: "pnpm verify" } }
      },
      {
        type: "tool.started",
        sessionId: "session-1",
        turnId: "turn-1",
        call: { id: "call-2", name: "read_file", input: { path: "packages/cli/README.md" } }
      },
      {
        type: "tool.completed",
        sessionId: "session-1",
        turnId: "turn-1",
        result: { callId: "call-2", toolName: "read_file", ok: true, output: "first line\nsecond line\n" }
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
            decision: { status: "requires_approval", reason },
            evidence: {
              rule: "approval_required",
              matched: "pnpm verify",
              commandPreview: "pnpm verify"
            }
          }
        }
      }
    ];

    for (const event of events) {
      await renderer.render(event);
    }

    expect(output.text()).toContain('[tool] run_powershell started [status=running] command="pnpm verify"\n');
    expect(output.text()).toContain('[tool] read_file started [status=running] path="packages/cli/README.md"\n');
    expect(output.text()).toMatch(
      /\[ok\] read_file completed \[output=text chars=23 lines=2\]: first line second line duration=\d+ms\n/
    );
    expect(output.text()).toMatch(
      /\[error\] run_powershell failed \[risk=shell source=permission_engine action=approval_required mode=default\] duration=\d+ms\n  reason: default mode requires approval\n  evidence: rule=approval_required matched="pnpm verify" command="pnpm verify"\n/
    );
    expect(output.text()).not.toContain("\u001B[");
  });

  it("uses stable scrollback badges for tool lifecycle, permissions, errors, and usage", async () => {
    const output = createOutput();
    const renderer = createEventRenderer({ stdout: output.stream });
    const reason = "mode=default tool=run_powershell risk=shell action=approval_required: default mode requires approval";
    const events: TDCodeEvent[] = [
      {
        type: "tool.started",
        sessionId: "session-1",
        turnId: "turn-1",
        call: { id: "call-1", name: "run_powershell", input: { command: "pnpm verify" } }
      },
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
        usage: { inputTokens: 1234, outputTokens: 56 }
      }
    ];

    for (const event of events) {
      await renderer.render(event);
    }

    const lines = output.text().trim().split("\n");
    expect(lines[0]).toBe('[tool] run_powershell started [status=running] command="pnpm verify"');
    expect(lines[1]).toBe(
      "[permission] run_powershell requires_approval [risk=shell action=approval_required mode=default] default mode requires approval"
    );
    expect(lines[1]).not.toContain("permission permission");
    expect(lines[1]).not.toContain("tool=run_powershell]");
    expect(lines[2]).toMatch(
      /^\[error\] run_powershell failed \[risk=shell source=permission_engine action=approval_required mode=default\] duration=\d+ms$/
    );
    expect(lines[3]).toBe("  reason: default mode requires approval");
    expect(lines[4]).toBe("[usage] usage input=1,234 output=56 total=1,290");
    expect(output.text()).not.toContain("\u001B[");
  });

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

    expect(output.text()).toMatch(/^hello world\n\[tool\] read_file started \[status=running\] path="README\.md"\n/);
    expect(output.text()).toContain("read_file completed [output=text chars=4 lines=1]: done duration=");
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

    expect(output.text()).toContain("\u001B[36m[tool]\u001B[0m read_file started");
    expect(output.text()).toContain("\u001B[32m[ok]\u001B[0m read_file completed");
    expect(output.text()).toContain("\u001B[36m[usage]\u001B[0m usage input=\u001B[36m2\u001B[0m output=\u001B[36m3\u001B[0m total=\u001B[36m5\u001B[0m");
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

    expect(output.text()).toContain(
      "[permission] run_powershell requires_approval [risk=shell action=approval_required mode=default] default mode requires approval\n"
    );
    expect(output.text()).toMatch(
      /run_powershell failed \[risk=shell source=permission_engine action=approval_required mode=default\]\n  reason: default mode requires approval\n/
    );
    expect(output.text()).toContain("usage input=7 output=11 total=18\n");
    expect(output.text()).not.toContain("\u001B[");
  });

  it("compacts structured permission reasons into scan-friendly metadata", async () => {
    const output = createOutput();
    const renderer = createEventRenderer({ stdout: output.stream });
    const reason = "mode=default tool=run_powershell risk=shell action=approval_required: default mode requires approval before running shell tools";
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
      }
    ];

    for (const event of events) {
      await renderer.render(event);
    }

    expect(output.text()).toContain(
      "run_powershell requires_approval [risk=shell action=approval_required mode=default] default mode requires approval before running shell tools\n"
    );
    expect(output.text()).toMatch(
      /run_powershell failed \[risk=shell source=permission_engine action=approval_required mode=default\]\n  reason: default mode requires approval before running shell tools\n/
    );
    expect(output.text()).not.toContain("mode=default tool=run_powershell risk=shell action=approval_required:");
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

    expect(output.text()).toContain(
      "\u001B[31m[permission]\u001B[0m \u001B[36mwrite_file\u001B[0m \u001B[31mdenied\u001B[0m [risk=\u001B[33mwrite\u001B[0m action=\u001B[2mdenied\u001B[0m mode=\u001B[2msafe\u001B[0m]"
    );
    expect(output.text()).toContain(
      "\u001B[31mfailed\u001B[0m [risk=\u001B[33mwrite\u001B[0m source=\u001B[2mpermission_engine\u001B[0m action=\u001B[2mdenied\u001B[0m mode=\u001B[2msafe\u001B[0m]"
    );
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
