import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { AgentHubAgentStreamPayload, ModelProvider } from "@tokendance/code-sdk";
import { createAgentHubTokenDanceRunner } from "../src/index.js";

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
