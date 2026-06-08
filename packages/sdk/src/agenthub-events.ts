import type { TDCodeEvent, TDCodeEventSink } from "@tokendance/code-core";

export type AgentHubRuntimeEventType =
  | "run.agent.text_delta"
  | "run.agent.text_block"
  | "run.agent.tool_call"
  | "run.agent.tool_result"
  | "run.agent.permission_requested"
  | "run.agent.permission_decided"
  | "run.agent.result";

export interface AgentHubRuntimeEvent {
  eventType: AgentHubRuntimeEventType;
  sourceEventType: TDCodeEvent["type"];
  sessionId: string;
  turnId: string;
  payload: Record<string, unknown>;
}

export type AgentHubRuntimeEventEmitter = (event: AgentHubRuntimeEvent) => void | Promise<void>;

export function toAgentHubRuntimeEvents(event: TDCodeEvent): AgentHubRuntimeEvent[] {
  if (!("sessionId" in event) || !("turnId" in event)) {
    return [];
  }

  const base = {
    sourceEventType: event.type,
    sessionId: event.sessionId,
    turnId: event.turnId
  };

  switch (event.type) {
    case "assistant.delta":
      return [
        {
          ...base,
          eventType: "run.agent.text_delta",
          payload: { sessionId: event.sessionId, turnId: event.turnId, text: event.text }
        }
      ];
    case "assistant.completed":
      return [
        {
          ...base,
          eventType: "run.agent.text_block",
          payload: { sessionId: event.sessionId, turnId: event.turnId, text: event.message.content }
        }
      ];
    case "tool.started":
      return [
        {
          ...base,
          eventType: "run.agent.tool_call",
          payload: {
            sessionId: event.sessionId,
            turnId: event.turnId,
            callId: event.call.id,
            toolName: event.call.name,
            input: event.call.input
          }
        }
      ];
    case "tool.permission":
      return [
        {
          ...base,
          eventType: event.decision.status === "requires_approval" ? "run.agent.permission_requested" : "run.agent.permission_decided",
          payload: {
            sessionId: event.sessionId,
            turnId: event.turnId,
            requestId: event.call.id,
            callId: event.call.id,
            toolName: event.call.name,
            input: event.call.input,
            status: event.decision.status,
            decision: toAgentHubDecision(event.decision.status),
            reason: event.decision.reason
          }
        }
      ];
    case "tool.completed":
      return [
        {
          ...base,
          eventType: "run.agent.tool_result",
          payload: {
            sessionId: event.sessionId,
            turnId: event.turnId,
            callId: event.result.callId,
            toolName: event.result.toolName,
            ok: event.result.ok,
            output: event.result.output,
            error: event.result.error
          }
        }
      ];
    case "turn.completed":
      return [
        {
          ...base,
          eventType: "run.agent.result",
          payload: {
            sessionId: event.sessionId,
            turnId: event.turnId,
            success: true,
            summary: event.finalResponse,
            usage: event.usage
          }
        }
      ];
    default:
      return [];
  }
}

export function createAgentHubEventSink(emit: AgentHubRuntimeEventEmitter): TDCodeEventSink {
  return async (event) => {
    for (const mapped of toAgentHubRuntimeEvents(event)) {
      await emit(mapped);
    }
  };
}

function toAgentHubDecision(status: "allowed" | "denied" | "requires_approval"): "allow" | "deny" | "pending" {
  if (status === "allowed") {
    return "allow";
  }
  if (status === "denied") {
    return "deny";
  }
  return "pending";
}
