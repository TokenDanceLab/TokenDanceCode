import type { PermissionApprovalCallback, PermissionApprovalRequest, PermissionDecision, ToolRisk } from "@tokendance/code-core";
import {
  AGENTHUB_AGENT_STREAM_SOURCE,
  AGENTHUB_APPROVAL_BRIDGE_SCHEMA_VERSION,
  AGENTHUB_APPROVAL_DECISION_CHANNEL,
  AGENTHUB_SDK_CONTRACT_VERSION
} from "./package-info.js";

export type AgentHubApprovalDecision = "allow" | "deny";

export interface AgentHubApprovalRequest {
  requestId: string;
  schemaVersion: typeof AGENTHUB_APPROVAL_BRIDGE_SCHEMA_VERSION;
  sdkContractVersion: typeof AGENTHUB_SDK_CONTRACT_VERSION;
  source: typeof AGENTHUB_AGENT_STREAM_SOURCE;
  decisionChannel: typeof AGENTHUB_APPROVAL_DECISION_CHANNEL;
  callId: string;
  sessionId: string;
  turnId: string;
  toolName: string;
  toolRisk: ToolRisk;
  input: unknown;
  status: "requires_approval";
  reason: string;
  createdAt: string;
}

export interface AgentHubApprovalBridgeOptions {
  onRequest: (request: AgentHubApprovalRequest) => void | Promise<void>;
  clock?: () => string;
  timeoutMs?: number;
}

export interface AgentHubApprovalBridge {
  approvalCallback: PermissionApprovalCallback;
  decide(requestId: string, decision: AgentHubApprovalDecision, reason?: string): boolean;
  pending(): AgentHubApprovalRequest[];
}

interface PendingApproval {
  request: AgentHubApprovalRequest;
  resolve: (decision: PermissionDecision) => void;
  settledDecision?: PermissionDecision;
  timeout?: ReturnType<typeof setTimeout>;
}

export function createAgentHubApprovalBridge(options: AgentHubApprovalBridgeOptions): AgentHubApprovalBridge {
  const pending = new Map<string, PendingApproval>();
  const clock = options.clock ?? (() => new Date().toISOString());

  return {
    async approvalCallback(request: PermissionApprovalRequest): Promise<PermissionDecision> {
      const requestId = allocateRequestId(request.call.id, pending);
      const approvalRequest = toAgentHubApprovalRequest(request, requestId, clock());
      let approval!: PendingApproval;
      const decisionPromise = new Promise<PermissionDecision>((resolve) => {
        approval = {
          request: approvalRequest,
          resolve(decision) {
            if (approval.timeout) {
              clearTimeout(approval.timeout);
            }
            approval.settledDecision = decision;
            resolve(decision);
          }
        };
        pending.set(approvalRequest.requestId, approval);
        if (options.timeoutMs !== undefined) {
          approval.timeout = setTimeout(() => {
            if (!pending.delete(approvalRequest.requestId)) {
              return;
            }
            approval.resolve({
              status: "denied",
              reason: `AgentHub approval timed out after ${options.timeoutMs}ms`
            });
          }, Math.max(0, Math.floor(options.timeoutMs)));
        }
      });
      try {
        await options.onRequest(cloneAgentHubApprovalRequest(approvalRequest));
      } catch (error) {
        if (approval.settledDecision) {
          return approval.settledDecision;
        }
        pending.delete(approvalRequest.requestId);
        return { status: "denied", reason: `AgentHub approval request failed: ${errorMessage(error)}` };
      }
      return decisionPromise;
    },

    decide(requestId: string, decision: AgentHubApprovalDecision, reason?: string): boolean {
      const approval = pending.get(requestId);
      if (!approval) {
        return false;
      }
      pending.delete(requestId);
      approval.resolve(toPermissionDecision(decision, reason));
      return true;
    },

    pending(): AgentHubApprovalRequest[] {
      return [...pending.values()].map(({ request }) => cloneAgentHubApprovalRequest(request));
    }
  };
}

function toAgentHubApprovalRequest(request: PermissionApprovalRequest, requestId: string, createdAt: string): AgentHubApprovalRequest {
  return {
    requestId,
    schemaVersion: AGENTHUB_APPROVAL_BRIDGE_SCHEMA_VERSION,
    sdkContractVersion: AGENTHUB_SDK_CONTRACT_VERSION,
    source: AGENTHUB_AGENT_STREAM_SOURCE,
    decisionChannel: AGENTHUB_APPROVAL_DECISION_CHANNEL,
    callId: request.call.id,
    sessionId: request.session.id,
    turnId: request.turnId,
    toolName: request.tool.name,
    toolRisk: request.tool.risk,
    input: cloneUnknown(request.call.input),
    status: "requires_approval",
    reason: request.decision.reason,
    createdAt
  };
}

function allocateRequestId(callId: string, pending: Map<string, PendingApproval>): string {
  if (!pending.has(callId)) {
    return callId;
  }
  for (let counter = 2; ; counter += 1) {
    const candidate = `${callId}#${counter}`;
    if (!pending.has(candidate)) {
      return candidate;
    }
  }
}

function toPermissionDecision(decision: AgentHubApprovalDecision, reason?: string): PermissionDecision {
  if (decision === "allow") {
    return { status: "allowed", reason: reason ?? "approved by AgentHub" };
  }
  return { status: "denied", reason: reason ?? "denied by AgentHub" };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function cloneAgentHubApprovalRequest(request: AgentHubApprovalRequest): AgentHubApprovalRequest {
  return {
    ...request,
    input: cloneUnknown(request.input)
  };
}

function cloneUnknown<T>(value: T): T {
  try {
    return structuredClone(value);
  } catch {
    return value;
  }
}
