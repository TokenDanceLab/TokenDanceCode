import {
  TokenDanceCode,
  createAgentHubAgentStreamSink,
  createAgentHubApprovalBridge,
  type AgentHubAgentStreamEmitter,
  type AgentHubApprovalDecision,
  type AgentHubApprovalRequest,
  type ModelProvider,
  type PermissionMode,
  type TokenDanceProviderConfig,
  type TurnResult
} from "@tokendance/code-sdk";

export interface AgentHubTokenDanceRunnerOptions {
  provider?: ModelProvider | TokenDanceProviderConfig;
  storageRoot?: string;
  env?: Record<string, string | undefined>;
  emitAgentStream: AgentHubAgentStreamEmitter;
  onApprovalRequest?: (request: AgentHubApprovalRequest) => void | Promise<void>;
  clock?: () => string;
}

export interface AgentHubTokenDanceRunOptions {
  prompt: string;
  workingDirectory: string;
  permissionMode?: PermissionMode;
  taskId: string;
  edgeRunId: string;
  sessionId: string;
  agentInstanceId: string;
}

export interface AgentHubTokenDanceRunner {
  run(options: AgentHubTokenDanceRunOptions): Promise<TurnResult>;
  decideApproval(requestId: string, decision: AgentHubApprovalDecision, reason?: string): boolean;
  pendingApprovals(): AgentHubApprovalRequest[];
}

export function createAgentHubTokenDanceRunner(options: AgentHubTokenDanceRunnerOptions): AgentHubTokenDanceRunner {
  const approvalBridge = options.onApprovalRequest
    ? createAgentHubApprovalBridge({ onRequest: options.onApprovalRequest, clock: options.clock })
    : undefined;

  return {
    async run(runOptions) {
      const client = new TokenDanceCode({
        provider: options.provider,
        storageRoot: options.storageRoot,
        env: options.env,
        approvalCallback: approvalBridge?.approvalCallback,
        eventSink: createAgentHubAgentStreamSink(
          {
            taskId: runOptions.taskId,
            edgeRunId: runOptions.edgeRunId,
            sessionId: runOptions.sessionId,
            agentInstanceId: runOptions.agentInstanceId,
            clock: options.clock
          },
          options.emitAgentStream
        )
      });
      const thread = client.startThread({
        workingDirectory: runOptions.workingDirectory,
        permissionMode: runOptions.permissionMode
      });
      return thread.run(runOptions.prompt);
    },

    decideApproval(requestId, decision, reason) {
      return approvalBridge?.decide(requestId, decision, reason) ?? false;
    },

    pendingApprovals() {
      return approvalBridge?.pending() ?? [];
    }
  };
}
