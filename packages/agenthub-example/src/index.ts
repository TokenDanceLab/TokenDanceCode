import {
  TOKEN_DANCE_CODE_PACKAGE,
  TokenDanceCode,
  createAgentHubAgentStreamEmitter,
  createAgentHubEventSink,
  createAgentHubApprovalBridge,
  createTokenDanceIdLoginRequest,
  verifyTokenDanceIdCallback,
  type AgentHubAgentStreamEmitter,
  type AgentHubApprovalDecision,
  type AgentHubApprovalRequest,
  type AgentHubRuntimeEvent,
  type DoctorInfo,
  type ModelProvider,
  type PermissionMode,
  type ThreadContext,
  type TokenDanceIdCallbackResult,
  type TokenDanceIdLoginRequest,
  type TokenDanceCodePackageInfo,
  type TokenDanceProviderConfig,
  type TurnResult
} from "@tokendance/code-sdk";

export interface AgentHubTokenDanceRunnerOptions {
  provider?: ModelProvider | TokenDanceProviderConfig;
  storageRoot?: string;
  env?: Record<string, string | undefined>;
  defaultPermissionMode?: PermissionMode;
  contextMaxRecentMessages?: number;
  streamIdFactory?: (eventSeq: number, event: AgentHubRuntimeEvent) => string;
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

export interface AgentHubTokenDanceContextOptions {
  prompt: string;
  workingDirectory: string;
  permissionMode?: PermissionMode;
  sessionId: string;
  maxRecentMessages?: number;
}

export interface AgentHubTokenDanceDoctorOptions {
  workingDirectory?: string;
  homeDir?: string;
}

export interface AgentHubTokenDanceIdLoginOptions {
  issuerUrl?: string;
  clientId: string;
  redirectUri: string;
  scope?: string | string[];
  state?: string;
  nonce?: string;
  codeVerifier?: string;
  deviceType?: string;
  deviceId?: string;
}

export interface AgentHubTokenDanceRunner {
  run(options: AgentHubTokenDanceRunOptions): Promise<TurnResult>;
  context(options: AgentHubTokenDanceContextOptions): Promise<ThreadContext>;
  packageInfo(): TokenDanceCodePackageInfo;
  doctor(options?: AgentHubTokenDanceDoctorOptions): Promise<DoctorInfo>;
  createTokenDanceIdLogin(options: AgentHubTokenDanceIdLoginOptions): TokenDanceIdLoginRequest;
  verifyTokenDanceIdCallback(callbackUrl: string | URL | URLSearchParams, request: TokenDanceIdLoginRequest): TokenDanceIdCallbackResult;
  decideApproval(requestId: string, decision: AgentHubApprovalDecision, reason?: string): boolean;
  pendingApprovals(): AgentHubApprovalRequest[];
}

export function createAgentHubTokenDanceRunner(options: AgentHubTokenDanceRunnerOptions): AgentHubTokenDanceRunner {
  let activeApprovalRequestEmitter: ((request: AgentHubApprovalRequest) => void | Promise<void>) | undefined;
  const approvalBridge = options.onApprovalRequest
    ? createAgentHubApprovalBridge({
        clock: options.clock,
        async onRequest(request) {
          await activeApprovalRequestEmitter?.(request);
          await options.onApprovalRequest?.(request);
        }
      })
    : undefined;

  return {
    packageInfo() {
      return TOKEN_DANCE_CODE_PACKAGE;
    },

    doctor(doctorOptions = {}) {
      return new TokenDanceCode({
        provider: options.provider,
        storageRoot: options.storageRoot,
        env: options.env
      }).doctor({
        projectRoot: doctorOptions.workingDirectory ?? options.storageRoot ?? process.cwd(),
        homeDir: doctorOptions.homeDir
      });
    },

    createTokenDanceIdLogin(loginOptions) {
      return createTokenDanceIdLoginRequest({
        issuerUrl: loginOptions.issuerUrl,
        clientId: loginOptions.clientId,
        redirectUri: loginOptions.redirectUri,
        scope: loginOptions.scope,
        state: loginOptions.state,
        nonce: loginOptions.nonce,
        codeVerifier: loginOptions.codeVerifier,
        extraParams: {
          device_type: loginOptions.deviceType,
          device_id: loginOptions.deviceId
        }
      });
    },

    verifyTokenDanceIdCallback(callbackUrl, request) {
      return verifyTokenDanceIdCallback(callbackUrl, request);
    },

    async run(runOptions) {
      const storageRoot = options.storageRoot ?? runOptions.workingDirectory;
      const emitAgentStream = createAgentHubAgentStreamEmitter(
        {
          taskId: runOptions.taskId,
          edgeRunId: runOptions.edgeRunId,
          sessionId: runOptions.sessionId,
          agentInstanceId: runOptions.agentInstanceId,
          idFactory: options.streamIdFactory,
          clock: options.clock
        },
        options.emitAgentStream
      );
      const client = new TokenDanceCode({
        provider: options.provider,
        storageRoot,
        env: options.env,
        approvalCallback: approvalBridge?.approvalCallback,
        eventSink: createAgentHubEventSink(emitAgentStream)
      });
      activeApprovalRequestEmitter = (request) => emitAgentStream(toPermissionRequestedRuntimeEvent(request));
      try {
        const thread = await resumeOrStartThread(client, runOptions, storageRoot, options.defaultPermissionMode);
        return await thread.run(runOptions.prompt);
      } finally {
        activeApprovalRequestEmitter = undefined;
      }
    },

    async context(contextOptions) {
      const storageRoot = options.storageRoot ?? contextOptions.workingDirectory;
      const client = new TokenDanceCode({
        provider: options.provider,
        storageRoot,
        env: options.env
      });
      const thread = await resumeOrStartThread(client, contextOptions, storageRoot, options.defaultPermissionMode);
      return thread.context(contextOptions.prompt, {
        maxRecentMessages: contextOptions.maxRecentMessages ?? options.contextMaxRecentMessages
      });
    },

    decideApproval(requestId, decision, reason) {
      return approvalBridge?.decide(requestId, decision, reason) ?? false;
    },

    pendingApprovals() {
      return approvalBridge?.pending() ?? [];
    }
  };
}

async function resumeOrStartThread(
  client: TokenDanceCode,
  runOptions: Pick<AgentHubTokenDanceRunOptions, "sessionId" | "workingDirectory" | "permissionMode">,
  storageRoot: string,
  defaultPermissionMode: PermissionMode = "default"
) {
  try {
    return await client.resume({ sessionId: runOptions.sessionId, storageRoot });
  } catch (error) {
    if (!isMissingSessionError(error)) {
      throw error;
    }
    return client.startThread({
      id: runOptions.sessionId,
      workingDirectory: runOptions.workingDirectory,
      permissionMode: runOptions.permissionMode ?? defaultPermissionMode
    });
  }
}

function toPermissionRequestedRuntimeEvent(request: AgentHubApprovalRequest): AgentHubRuntimeEvent {
  return {
    eventType: "run.agent.permission_requested",
    sourceEventType: "tool.permission",
    sessionId: request.sessionId,
    turnId: request.turnId,
    payload: {
      sessionId: request.sessionId,
      turnId: request.turnId,
      requestId: request.requestId,
      callId: request.requestId,
      toolName: request.toolName,
      toolRisk: request.toolRisk,
      input: request.input,
      status: request.status,
      decision: "pending",
      reason: request.reason,
      createdAt: request.createdAt
    }
  };
}

function isMissingSessionError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === "ENOENT";
}
