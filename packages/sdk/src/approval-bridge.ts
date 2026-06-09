import type { PermissionApprovalCallback, PermissionApprovalRequest, PermissionDecision, ToolRisk } from "@tokendance/code-core";

export type AgentHubApprovalDecision = "allow" | "deny";

export interface AgentHubApprovalRequest {
  requestId: string;
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
}

export interface AgentHubApprovalBridge {
  approvalCallback: PermissionApprovalCallback;
  decide(requestId: string, decision: AgentHubApprovalDecision, reason?: string): boolean;
  pending(): AgentHubApprovalRequest[];
}

interface PendingApproval {
  request: AgentHubApprovalRequest;
  resolve: (decision: PermissionDecision) => void;
}

export function createAgentHubApprovalBridge(options: AgentHubApprovalBridgeOptions): AgentHubApprovalBridge {
  const pending = new Map<string, PendingApproval>();
  const clock = options.clock ?? (() => new Date().toISOString());

  return {
    async approvalCallback(request: PermissionApprovalRequest): Promise<PermissionDecision> {
      const requestId = allocateRequestId(request.call.id, pending);
      const approvalRequest = toAgentHubApprovalRequest(request, requestId, clock());
      const decisionPromise = new Promise<PermissionDecision>((resolve) => {
        pending.set(approvalRequest.requestId, { request: approvalRequest, resolve });
      });
      try {
        await options.onRequest(approvalRequest);
      } catch (error) {
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
      return [...pending.values()].map(({ request }) => ({ ...request }));
    }
  };
}

function toAgentHubApprovalRequest(request: PermissionApprovalRequest, requestId: string, createdAt: string): AgentHubApprovalRequest {
  return {
    requestId,
    callId: request.call.id,
    sessionId: request.session.id,
    turnId: request.turnId,
    toolName: request.tool.name,
    toolRisk: request.tool.risk,
    input: request.call.input,
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
