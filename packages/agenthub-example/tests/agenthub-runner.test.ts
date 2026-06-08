import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { AgentHubAgentStreamPayload } from "@tokendance/code-sdk";
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
