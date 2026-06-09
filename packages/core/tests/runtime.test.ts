import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AgentRuntime, FileTranscriptStore, MockProvider, type ModelProvider, type ModelTurnRequest, type ModelTurnResponse, type RuntimeHookCommand, type TDMessage } from "../src/index.js";

class WriteFileOnceProvider implements ModelProvider {
  async createTurn(request: ModelTurnRequest): Promise<ModelTurnResponse> {
    if (request.toolResults.length > 0) {
      return { assistantMessage: "done", toolCalls: [] };
    }
    return {
      toolCalls: [
        {
          id: "write-denied",
          name: "write_file",
          input: { path: "denied.txt", content: "should not write" }
        }
      ]
    };
  }
}

class DangerousPowerShellOnceProvider implements ModelProvider {
  async createTurn(request: ModelTurnRequest): Promise<ModelTurnResponse> {
    if (request.toolResults.length > 0) {
      return { assistantMessage: "done", toolCalls: [] };
    }
    return {
      toolCalls: [
        {
          id: "shell-hard-deny",
          name: "run_powershell",
          input: { command: "git reset --hard HEAD", timeout: 5 }
        }
      ]
    };
  }
}

class FailingProvider implements ModelProvider {
  async createTurn(): Promise<ModelTurnResponse> {
    throw new Error("provider unavailable");
  }
}

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

  it("passes layered parent instructions to the provider when cwd is nested", async () => {
    const root = await mkdtemp(join(tmpdir(), "tdcode-core-context-"));
    const nested = join(root, "packages", "app");
    await mkdir(join(root, ".git"), { recursive: true });
    await mkdir(nested, { recursive: true });
    await writeFile(join(root, "AGENTS.md"), "Use workspace parent rules.\n", "utf8");
    await writeFile(join(nested, "AGENTS.md"), "Use nested package rules.\n", "utf8");
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
      cwd: nested,
      provider,
      store: new FileTranscriptStore({ rootDir: root })
    });

    await runtime.initialize();
    for await (const _event of runtime.runTurn("inspect nested workspace")) {
      // Drain the event stream.
    }

    const systemContent = seenMessages[0]?.[0]?.content ?? "";
    expect(systemContent).toContain("Use workspace parent rules.");
    expect(systemContent).toContain("Use nested package rules.");
    expect(systemContent.indexOf("Use workspace parent rules.")).toBeLessThan(systemContent.indexOf("Use nested package rules."));
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

  it("emits and persists a turn.failed event before rethrowing provider errors", async () => {
    const root = await mkdtemp(join(tmpdir(), "tdcode-core-provider-fail-"));
    const runtime = new AgentRuntime({
      cwd: root,
      provider: new FailingProvider(),
      store: new FileTranscriptStore({ rootDir: root })
    });
    const events = [];

    await runtime.initialize();
    await expect(async () => {
      for await (const event of runtime.runTurn("call provider")) {
        events.push(event);
      }
    }).rejects.toThrow("provider unavailable");

    expect(events).toEqual([
      expect.objectContaining({ type: "user.message" }),
      expect.objectContaining({
        type: "turn.failed",
        error: "provider unavailable"
      })
    ]);
    const content = await readFile(
      join(root, ".tokendance", "sessions", runtime.state.id, "transcript.jsonl"),
      "utf8"
    );
    const transcriptEvents = content
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line).event.type);
    expect(transcriptEvents).toEqual(["user.message", "turn.failed"]);
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

  it("persists denial evidence in the tool completed transcript event", async () => {
    const root = await mkdtemp(join(tmpdir(), "tdcode-core-"));
    const runtime = new AgentRuntime({
      cwd: root,
      provider: new WriteFileOnceProvider(),
      session: {
        id: "safe-denial-session",
        cwd: root,
        createdAt: "2026-06-09T00:00:00.000Z",
        updatedAt: "2026-06-09T00:00:00.000Z",
        permissionMode: "safe",
        messages: []
      },
      store: new FileTranscriptStore({ rootDir: root })
    });

    await runtime.initialize();
    for await (const _event of runtime.runTurn("try write")) {
      // Drain the event stream to force transcript writes.
    }

    const content = await readFile(
      join(root, ".tokendance", "sessions", runtime.state.id, "transcript.jsonl"),
      "utf8"
    );
    const toolCompleted = content
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line))
      .find((envelope) => envelope.event.type === "tool.completed");

    expect(toolCompleted.event.result).toMatchObject({
      ok: false,
      safetyEvidence: {
        source: "permission_engine",
        status: "denied",
        reason: "mode=safe tool=write_file risk=write action=denied: safe mode only allows read-only tools"
      }
    });
  });

  it("normalizes approval callback decisions and still preserves PowerShell hard-deny evidence", async () => {
    const root = await mkdtemp(join(tmpdir(), "tdcode-core-"));
    const events = [];
    const runtime = new AgentRuntime({
      cwd: root,
      provider: new DangerousPowerShellOnceProvider(),
      approvalCallback: async () => ({
        status: "allowed",
        reason: "external bridge approved shell",
        riskMetadata: {
          mode: "yolo",
          toolName: "forged",
          toolRisk: "read",
          action: "allowed",
          approvalScope: "none",
          concurrency: "parallel_safe",
          safetyNotes: ["forged metadata"]
        }
      })
    });

    for await (const event of runtime.runTurn("try dangerous shell")) {
      events.push(event);
    }

    expect(events).toContainEqual(
      expect.objectContaining({
        type: "tool.permission",
        decision: expect.objectContaining({
          status: "allowed",
          reason: "external bridge approved shell",
          riskMetadata: expect.objectContaining({
            mode: "default",
            toolName: "run_powershell",
            toolRisk: "shell",
            action: "allowed",
            approvalScope: "none",
            concurrency: "exclusive",
            safetyNotes: ["PowerShell classifier hard-denies destructive commands before execution."]
          })
        })
      })
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "tool.completed",
        result: expect.objectContaining({
          ok: false,
          safetyEvidence: expect.objectContaining({
            toolName: "run_powershell",
            source: "powershell_classifier",
            status: "denied",
            evidence: {
              rule: "git reset --hard",
              matched: "git reset --hard",
              commandPreview: "git reset --hard HEAD"
            }
          })
        })
      })
    );
  });

  it("keeps configured hooks disabled by default", async () => {
    const root = await mkdtemp(join(tmpdir(), "tdcode-core-hooks-disabled-"));
    const recorder = await createHookRecorder(root);
    const runtime = new AgentRuntime({
      cwd: root,
      provider: new MockProvider(),
      hooks: {
        commands: [
          { event: "PreToolUse", ...recorder }
        ]
      }
    });

    for await (const _event of runtime.runTurn("echo: hooks disabled")) {
      // Drain the event stream.
    }

    await expect(stat(recorder.logPath)).rejects.toThrow();
  });

  it("runs enabled hooks with deterministic JSON payloads", async () => {
    const root = await mkdtemp(join(tmpdir(), "tdcode-core-hooks-"));
    const recorder = await createHookRecorder(root);
    const runtime = new AgentRuntime({
      cwd: root,
      provider: new MockProvider(),
      hooks: {
        enabled: true,
        commands: [
          { event: "PreToolUse", ...recorder },
          { event: "PostToolUse", ...recorder },
          { event: "TurnCompleted", ...recorder }
        ]
      }
    });

    for await (const _event of runtime.runTurn("echo: hooks enabled")) {
      // Drain the event stream.
    }

    const payloads = await readHookPayloads(recorder.logPath);
    expect(payloads.map((payload) => payload.event)).toEqual(["PreToolUse", "PostToolUse", "TurnCompleted"]);
    expect(payloads[0]).toMatchObject({
      event: "PreToolUse",
      sessionId: runtime.state.id,
      cwd: root,
      toolCall: {
        id: "mock-echo-1",
        name: "echo",
        input: { text: "hooks enabled" }
      },
      permission: {
        status: "allowed"
      }
    });
    expect(payloads[1]).toMatchObject({
      event: "PostToolUse",
      toolCall: { name: "echo" },
      result: {
        callId: "mock-echo-1",
        toolName: "echo",
        ok: true,
        output: { text: "hooks enabled" }
      }
    });
    expect(payloads[2]).toMatchObject({
      event: "TurnCompleted",
      finalResponse: 'Tool result: {"text":"hooks enabled"}'
    });
  });

  it("emits turn.failed when an enabled hook command fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "tdcode-core-hooks-fail-"));
    const runtime = new AgentRuntime({
      cwd: root,
      provider: new MockProvider(),
      hooks: {
        enabled: true,
        commands: [
          { event: "PreToolUse", command: process.execPath, args: ["-e", "process.exit(7)"] }
        ]
      }
    });
    const events = [];

    await expect(async () => {
      for await (const event of runtime.runTurn("echo: hook fails")) {
        events.push(event);
      }
    }).rejects.toThrow("Hook PreToolUse failed");

    expect(events).toEqual([
      expect.objectContaining({ type: "user.message" }),
      expect.objectContaining({
        type: "tool.started",
        call: expect.objectContaining({ name: "echo" })
      }),
      expect.objectContaining({ type: "tool.permission" }),
      expect.objectContaining({
        type: "turn.failed",
        error: expect.stringContaining("Hook PreToolUse failed")
      })
    ]);
  });

  it("emits turn.failed when an enabled hook command times out", async () => {
    const root = await mkdtemp(join(tmpdir(), "tdcode-core-hooks-timeout-"));
    const runtime = new AgentRuntime({
      cwd: root,
      provider: new MockProvider(),
      hooks: {
        enabled: true,
        commands: [
          { event: "PreToolUse", command: process.execPath, args: ["-e", "setTimeout(() => {}, 5000)"] }
        ]
      }
    });
    const events = [];

    await expect(async () => {
      for await (const event of runtime.runTurn("echo: hook times out")) {
        events.push(event);
      }
    }).rejects.toThrow("timed out after 2000ms");

    expect(events.at(-1)).toMatchObject({
      type: "turn.failed",
      error: expect.stringContaining("timed out after 2000ms")
    });
  });
});

async function createHookRecorder(root: string): Promise<Pick<RuntimeHookCommand, "command" | "args"> & { logPath: string }> {
  const hookPath = join(root, "record-hook.mjs");
  const logPath = join(root, "hooks.jsonl");
  await writeFile(
    hookPath,
    [
      'import { appendFileSync } from "node:fs";',
      'let input = "";',
      'process.stdin.setEncoding("utf8");',
      'process.stdin.on("data", (chunk) => { input += chunk; });',
      'process.stdin.on("end", () => {',
      '  appendFileSync(process.argv[2], `${JSON.stringify(JSON.parse(input))}\\n`, "utf8");',
      '});',
      ""
    ].join("\n"),
    "utf8"
  );
  return { command: process.execPath, args: [hookPath, logPath], logPath };
}

async function readHookPayloads(logPath: string): Promise<Array<Record<string, unknown>>> {
  return (await readFile(logPath, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}
