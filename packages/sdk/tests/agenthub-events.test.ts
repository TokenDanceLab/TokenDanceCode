import { describe, expect, it } from "vitest";
import { createAgentHubAgentStreamSink, createAgentHubEventSink, toAgentHubRuntimeEvents } from "../src/index.js";
import type { TDCodeEvent } from "../src/index.js";

describe("AgentHub event mapping", () => {
  it("maps TokenDanceCode assistant and tool events to AgentHub runtime event names", () => {
    const events: TDCodeEvent[] = [
      { type: "assistant.delta", sessionId: "session-1", turnId: "turn-1", text: "hello" },
      {
        type: "tool.started",
        sessionId: "session-1",
        turnId: "turn-1",
        call: { id: "call-1", name: "read_file", input: { path: "README.md" } }
      },
      {
        type: "tool.permission",
        sessionId: "session-1",
        turnId: "turn-1",
        call: { id: "call-1", name: "read_file", input: { path: "README.md" } },
        decision: { status: "allowed", reason: "read-only" }
      },
      {
        type: "tool.completed",
        sessionId: "session-1",
        turnId: "turn-1",
        result: { callId: "call-1", toolName: "read_file", ok: true, output: { path: "README.md" } }
      },
      {
        type: "turn.completed",
        sessionId: "session-1",
        turnId: "turn-1",
        finalResponse: "done",
        usage: { inputTokens: 2, outputTokens: 1 }
      }
    ];

    const mapped = events.flatMap(toAgentHubRuntimeEvents);

    expect(mapped.map((event) => event.eventType)).toEqual([
      "run.agent.text_delta",
      "run.agent.tool_call",
      "run.agent.permission_decided",
      "run.agent.tool_result",
      "run.agent.result"
    ]);
    expect(mapped[1]?.payload).toMatchObject({ callId: "call-1", toolName: "read_file" });
    expect(mapped[2]?.payload).toMatchObject({ requestId: "call-1", decision: "allow" });
    expect(mapped[4]?.payload).toMatchObject({ success: true, summary: "done", usage: { inputTokens: 2, outputTokens: 1 } });
  });

  it("maps requires_approval to AgentHub permission_requested", () => {
    const [mapped] = toAgentHubRuntimeEvents({
      type: "tool.permission",
      sessionId: "session-1",
      turnId: "turn-1",
      call: { id: "call-2", name: "write_file", input: { path: "README.md" } },
      decision: { status: "requires_approval", reason: "default mode requires approval for write tools" }
    });

    expect(mapped).toMatchObject({
      eventType: "run.agent.permission_requested",
      payload: {
        requestId: "call-2",
        toolName: "write_file",
        reason: "default mode requires approval for write tools"
      }
    });
  });

  it("creates a TDCode event sink for AgentHub emitters", async () => {
    const received: string[] = [];
    const sink = createAgentHubEventSink((event) => {
      received.push(event.eventType);
    });

    await sink({ type: "assistant.delta", sessionId: "session-1", turnId: "turn-1", text: "hello" });
    await sink({ type: "user.message", sessionId: "session-1", turnId: "turn-1", message: { role: "user", content: "ignored" } });

    expect(received).toEqual(["run.agent.text_delta"]);
  });

  it("wraps mapped runtime events as AgentHub agent.stream payloads", async () => {
    const frames: unknown[] = [];
    const sink = createAgentHubAgentStreamSink(
      {
        taskId: "task-1",
        edgeRunId: "edge-run-1",
        sessionId: "hub-session-1",
        agentInstanceId: "agent-1",
        idFactory: (seq) => `evt-${seq}`,
        clock: () => "2026-06-09T00:00:00.000Z"
      },
      (payload) => {
        frames.push(payload);
      }
    );

    await sink({ type: "assistant.delta", sessionId: "td-session-1", turnId: "turn-1", text: "hello" });
    await sink({ type: "user.message", sessionId: "td-session-1", turnId: "turn-1", message: { role: "user", content: "ignored" } });
    await sink({
      type: "tool.completed",
      sessionId: "td-session-1",
      turnId: "turn-1",
      result: { callId: "call-1", toolName: "read_file", ok: true, output: { path: "README.md" } }
    });

    expect(frames).toEqual([
      {
        schema_version: 1,
        sdk_contract_version: "agenthub-sdk.v1",
        source: "tokendance-code-sdk",
        id: "evt-1",
        task_id: "task-1",
        edge_run_id: "edge-run-1",
        session_id: "hub-session-1",
        agent_instance_id: "agent-1",
        event_seq: 1,
        event_type: "run.agent.text_delta",
        payload: expect.objectContaining({ text: "hello", sessionId: "td-session-1", turnId: "turn-1" }),
        created_at: "2026-06-09T00:00:00.000Z"
      },
      {
        schema_version: 1,
        sdk_contract_version: "agenthub-sdk.v1",
        source: "tokendance-code-sdk",
        id: "evt-2",
        task_id: "task-1",
        edge_run_id: "edge-run-1",
        session_id: "hub-session-1",
        agent_instance_id: "agent-1",
        event_seq: 2,
        event_type: "run.agent.tool_result",
        payload: expect.objectContaining({ callId: "call-1", toolName: "read_file", ok: true }),
        created_at: "2026-06-09T00:00:00.000Z"
      }
    ]);
  });
});
