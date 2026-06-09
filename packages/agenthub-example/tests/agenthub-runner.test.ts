import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { AgentHubAgentStreamPayload, ModelProvider } from "@tokendance/code-sdk";
import { createAgentHubTokenDanceRunner } from "../src/index.js";

class WriteFileProvider implements ModelProvider {
  async createTurn(request: Parameters<ModelProvider["createTurn"]>[0]) {
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
          id: "runner-write-remote",
          name: "write_file",
          input: { path: "runner-approved.txt", content: "approved through AgentHub runner" }
        }
      ]
    };
  }
}

describe("AgentHub TokenDanceCode runner example", () => {
  it("runs a TokenDanceCode thread and emits AgentHub agent.stream payloads", async () => {
    const root = await mkdtemp(join(tmpdir(), "tdcode-agenthub-example-"));
    const frames: AgentHubAgentStreamPayload[] = [];
    const runner = createAgentHubTokenDanceRunner({
      storageRoot: root,
      emitAgentStream(payload) {
        frames.push(payload);
      },
      clock: () => "2026-06-09T00:00:00.000Z"
    });

    const turn = await runner.run({
      prompt: "echo: agenthub",
      workingDirectory: root,
      permissionMode: "default",
      taskId: "task-1",
      edgeRunId: "edge-run-1",
      sessionId: "hub-session-1",
      agentInstanceId: "agent-1"
    });

    expect(turn.threadId).toBe("hub-session-1");
    await expect(readFile(join(root, ".tokendance", "sessions", "hub-session-1", "transcript.jsonl"), "utf8")).resolves.toContain("hub-session-1");
    expect(turn.finalResponse).toBe('Tool result: {"text":"agenthub"}');
    expect(frames.map((frame) => frame.event_type)).toEqual([
      "run.agent.tool_call",
      "run.agent.permission_decided",
      "run.agent.tool_result",
      "run.agent.text_delta",
      "run.agent.text_block",
      "run.agent.result"
    ]);
    expect(frames.map((frame) => frame.event_seq)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(frames[0]).toMatchObject({
      schema_version: 1,
      sdk_contract_version: "agenthub-sdk.v1",
      source: "tokendance-code-sdk",
      id: "tdcode_evt_1",
      task_id: "task-1",
      edge_run_id: "edge-run-1",
      session_id: "hub-session-1",
      agent_instance_id: "agent-1",
      created_at: "2026-06-09T00:00:00.000Z",
      payload: { toolName: "echo", input: { text: "agenthub" } }
    });
    expect(frames.at(-1)?.payload).toMatchObject({
      success: true,
      summary: 'Tool result: {"text":"agenthub"}'
    });
  });

  it("applies runner defaults and custom AgentHub stream ids", async () => {
    const root = await mkdtemp(join(tmpdir(), "tdcode-agenthub-example-"));
    const frames: AgentHubAgentStreamPayload[] = [];
    const seenPermissionModes: string[] = [];
    const provider: ModelProvider = {
      async createTurn(request) {
        seenPermissionModes.push(request.session.permissionMode);
        return {
          assistantMessage: "runner options ok",
          toolCalls: []
        };
      }
    };
    const runner = createAgentHubTokenDanceRunner({
      storageRoot: root,
      provider,
      defaultPermissionMode: "safe",
      streamIdFactory: (eventSeq, event) => `hub-${event.eventType}-${eventSeq}`,
      emitAgentStream(payload) {
        frames.push(payload);
      },
      clock: () => "2026-06-09T00:00:00.000Z"
    });

    await runner.run({
      prompt: "check runner options",
      workingDirectory: root,
      taskId: "task-options",
      edgeRunId: "edge-options",
      sessionId: "hub-session-options",
      agentInstanceId: "agent-options"
    });

    expect(seenPermissionModes).toEqual(["safe"]);
    expect(frames.map((frame) => frame.id)).toEqual([
      "hub-run.agent.text_delta-1",
      "hub-run.agent.text_block-2",
      "hub-run.agent.result-3"
    ]);
    expect(frames[0]).toMatchObject({
      schema_version: 1,
      sdk_contract_version: "agenthub-sdk.v1",
      source: "tokendance-code-sdk"
    });
  });

  it("resumes the supplied AgentHub session id across runner calls", async () => {
    const root = await mkdtemp(join(tmpdir(), "tdcode-agenthub-example-"));
    const seenMessages: string[][] = [];
    const provider: ModelProvider = {
      async createTurn(request) {
        seenMessages.push(request.session.messages.map((message) => message.content));
        const conversation = request.session.messages.filter((message) => message.role !== "system").map((message) => message.content);
        return {
          assistantMessage: `seen:${conversation.join("|")}`,
          toolCalls: []
        };
      }
    };
    const runner = createAgentHubTokenDanceRunner({
      storageRoot: root,
      provider,
      emitAgentStream() {}
    });

    await runner.run({
      prompt: "first prompt",
      workingDirectory: root,
      permissionMode: "default",
      taskId: "task-1",
      edgeRunId: "edge-run-1",
      sessionId: "hub-session-continuity",
      agentInstanceId: "agent-1"
    });
    await runner.run({
      prompt: "second prompt",
      workingDirectory: root,
      permissionMode: "default",
      taskId: "task-1",
      edgeRunId: "edge-run-2",
      sessionId: "hub-session-continuity",
      agentInstanceId: "agent-1"
    });

    expect(seenMessages[0]?.[0]).toContain("TokenDanceCode is a local command-line coding agent");
    expect(seenMessages[0]?.slice(1)).toEqual(["first prompt"]);
    expect(seenMessages[1]?.[0]).toContain("TokenDanceCode is a local command-line coding agent");
    expect(seenMessages[1]?.slice(1)).toEqual(["first prompt", "seen:first prompt", "second prompt"]);

    const transcript = await readTranscriptSeqs(root, "hub-session-continuity");
    expect(transcript).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it("previews context for the supplied AgentHub session without writing transcript events", async () => {
    const root = await mkdtemp(join(tmpdir(), "tdcode-agenthub-example-"));
    const runner = createAgentHubTokenDanceRunner({
      storageRoot: root,
      emitAgentStream() {}
    });

    await runner.run({
      prompt: "first AgentHub context turn",
      workingDirectory: root,
      permissionMode: "default",
      taskId: "task-1",
      edgeRunId: "edge-run-1",
      sessionId: "hub-session-context",
      agentInstanceId: "agent-1"
    });
    const beforeSeqs = await readTranscriptSeqs(root, "hub-session-context");

    const preview = await runner.context({
      prompt: "preview next turn",
      workingDirectory: root,
      permissionMode: "default",
      sessionId: "hub-session-context"
    });

    expect(preview.messages[0]).toMatchObject({ role: "system" });
    expect(preview.messages.map((message) => message.content)).toContain("first AgentHub context turn");
    expect(preview.messages.at(-1)).toEqual({ role: "user", content: "preview next turn" });
    await expect(readTranscriptSeqs(root, "hub-session-context")).resolves.toEqual(beforeSeqs);
  });

  it("limits runner context preview history for resumed AgentHub sessions", async () => {
    const root = await mkdtemp(join(tmpdir(), "tdcode-agenthub-example-"));
    const runner = createAgentHubTokenDanceRunner({
      storageRoot: root,
      contextMaxRecentMessages: 2,
      emitAgentStream() {}
    });

    await runner.run({
      prompt: "first runner context turn",
      workingDirectory: root,
      permissionMode: "default",
      taskId: "task-1",
      edgeRunId: "edge-run-1",
      sessionId: "hub-session-context-limit",
      agentInstanceId: "agent-1"
    });
    await runner.run({
      prompt: "second runner context turn",
      workingDirectory: root,
      permissionMode: "default",
      taskId: "task-1",
      edgeRunId: "edge-run-2",
      sessionId: "hub-session-context-limit",
      agentInstanceId: "agent-1"
    });

    const preview = await runner.context({
      prompt: "preview short runner context",
      workingDirectory: root,
      permissionMode: "default",
      sessionId: "hub-session-context-limit"
    });
    const visibleContent = preview.messages.map((message) => message.content);

    expect(visibleContent).not.toContain("first runner context turn");
    expect(visibleContent).toContain("second runner context turn");
    expect(visibleContent).toContain("Mock response: second runner context turn");
    expect(preview.messages.at(-1)).toEqual({ role: "user", content: "preview short runner context" });
  });

  it("bridges remote AgentHub approval decisions through the runner", async () => {
    const root = await mkdtemp(join(tmpdir(), "tdcode-agenthub-example-"));
    const frames: AgentHubAgentStreamPayload[] = [];
    const requests: unknown[] = [];
    let releaseRequest!: () => void;
    const requestSeen = new Promise<void>((resolve) => {
      releaseRequest = resolve;
    });
    const runner = createAgentHubTokenDanceRunner({
      storageRoot: root,
      provider: new WriteFileProvider(),
      onApprovalRequest(request) {
        requests.push(request);
        releaseRequest();
      },
      emitAgentStream(payload) {
        frames.push(payload);
      },
      clock: () => "2026-06-09T00:00:00.000Z"
    });

    const turnPromise = runner.run({
      prompt: "write through runner approval",
      workingDirectory: root,
      permissionMode: "default",
      taskId: "task-approval",
      edgeRunId: "edge-approval",
      sessionId: "hub-session-approval",
      agentInstanceId: "agent-approval"
    });
    await requestSeen;

    expect(requests).toEqual([
      expect.objectContaining({
        requestId: "runner-write-remote",
        sessionId: "hub-session-approval",
        toolName: "write_file",
        status: "requires_approval"
      })
    ]);
    expect(runner.pendingApprovals()).toEqual([
      expect.objectContaining({ requestId: "runner-write-remote", toolName: "write_file" })
    ]);
    await expect(readFile(join(root, "runner-approved.txt"), "utf8")).rejects.toThrow();

    expect(runner.decideApproval("runner-write-remote", "allow", "approved in AgentHub UI")).toBe(true);
    const turn = await turnPromise;

    expect(turn.finalResponse).toBe("write ok");
    await expect(readFile(join(root, "runner-approved.txt"), "utf8")).resolves.toBe("approved through AgentHub runner");
    expect(frames.map((frame) => frame.event_type)).toEqual([
      "run.agent.tool_call",
      "run.agent.permission_requested",
      "run.agent.permission_decided",
      "run.agent.tool_result",
      "run.agent.text_delta",
      "run.agent.text_block",
      "run.agent.result"
    ]);
    expect(runner.decideApproval("runner-write-remote", "deny")).toBe(false);
  });

  it("exposes package metadata and doctor diagnostics for AgentHub startup checks", async () => {
    const root = await mkdtemp(join(tmpdir(), "tdcode-agenthub-example-"));
    const runner = createAgentHubTokenDanceRunner({
      storageRoot: root,
      env: {
        OPENAI_API_KEY: "hidden-openai-key",
        ANTHROPIC_API_KEY: ""
      },
      emitAgentStream() {}
    });

    const packageInfo = runner.packageInfo();
    const doctor = await runner.doctor({ workingDirectory: root });

    expect(packageInfo.packages.sdk.name).toBe("@tokendance/code-sdk");
    expect(packageInfo.packages.cli.bin).toBe("tokendance");
    expect(doctor.cwd).toBe(root);
    expect(doctor.apiKeys).toEqual({
      OPENAI_API_KEY: "present",
      ANTHROPIC_API_KEY: "missing"
    });
    expect(JSON.stringify(doctor)).not.toContain("hidden-openai-key");
    expect(doctor.stateDir.writable).toBe(true);
  });
});

async function readTranscriptSeqs(root: string, sessionId: string): Promise<number[]> {
  const content = await readFile(join(root, ".tokendance", "sessions", sessionId, "transcript.jsonl"), "utf8");
  return content
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .map((line) => (JSON.parse(line) as { seq: number }).seq);
}
