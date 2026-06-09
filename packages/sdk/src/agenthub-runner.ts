import type { ModelProvider, PermissionMode } from "@tokendance/code-core";
import { AsyncLocalStorage } from "node:async_hooks";
import {
  createAgentHubAgentStreamEmitter,
  createAgentHubEventSink,
  type AgentHubAgentStreamEmitter,
  type AgentHubAgentStreamPayload,
  type AgentHubRuntimeEvent
} from "./agenthub-events.js";
import {
  createAgentHubApprovalBridge,
  type AgentHubApprovalDecision,
  type AgentHubApprovalRequest
} from "./approval-bridge.js";
import { TOKEN_DANCE_CODE_PACKAGE, type TokenDanceCodePackageInfo } from "./package-info.js";
import {
  createTokenDanceIdLoginRequest,
  verifyTokenDanceIdCallback,
  type TokenDanceIdCallbackResult,
  type TokenDanceIdLoginRequest
} from "./tokendance-id.js";
import { TokenDanceCode, type DoctorInfo, type ThreadContext, type TokenDanceProviderConfig, type TurnResult } from "./index.js";

const approvalEmitterStorage = new AsyncLocalStorage<(request: AgentHubApprovalRequest) => void | Promise<void>>();

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
  bootstrap(options?: AgentHubTokenDanceDoctorOptions): Promise<AgentHubTokenDanceBootstrapResult>;
  createTokenDanceIdLogin(options: AgentHubTokenDanceIdLoginOptions): TokenDanceIdLoginRequest;
  verifyTokenDanceIdCallback(callbackUrl: string | URL | URLSearchParams, request: TokenDanceIdLoginRequest): TokenDanceIdCallbackResult;
  decideApproval(requestId: string, decision: AgentHubApprovalDecision, reason?: string): boolean;
  pendingApprovals(): AgentHubApprovalRequest[];
}

export type AgentHubTokenDanceFixtureRunDefaults = Omit<AgentHubTokenDanceRunOptions, "prompt" | "permissionMode"> &
  Partial<Pick<AgentHubTokenDanceRunOptions, "permissionMode">>;

export type AgentHubTokenDanceFixtureRunOptions = Pick<AgentHubTokenDanceRunOptions, "prompt"> &
  Partial<Omit<AgentHubTokenDanceRunOptions, "prompt">>;

export type AgentHubTokenDanceFixtureContextOptions = Pick<AgentHubTokenDanceContextOptions, "prompt"> &
  Partial<Omit<AgentHubTokenDanceContextOptions, "prompt">>;

export interface AgentHubTokenDanceE2EFixtureOptions extends Omit<AgentHubTokenDanceRunnerOptions, "emitAgentStream" | "onApprovalRequest"> {
  defaultRun: AgentHubTokenDanceFixtureRunDefaults;
  defaultLogin?: Partial<AgentHubTokenDanceIdLoginOptions>;
  onAgentStream?: AgentHubAgentStreamEmitter;
  onApprovalRequest?: (request: AgentHubApprovalRequest) => void | Promise<void>;
}

export type AgentHubTokenDanceConsumerFixtureOptions = AgentHubTokenDanceE2EFixtureOptions;

export interface AgentHubTokenDanceBootstrapResult {
  packageInfo: TokenDanceCodePackageInfo;
  doctor: DoctorInfo;
}

export interface AgentHubTokenDanceE2EFixture {
  runner: AgentHubTokenDanceRunner;
  agentStream: AgentHubAgentStreamPayload[];
  approvalRequests: AgentHubApprovalRequest[];
  bootstrap(options?: AgentHubTokenDanceDoctorOptions): Promise<AgentHubTokenDanceBootstrapResult>;
  run(options: AgentHubTokenDanceFixtureRunOptions): Promise<TurnResult>;
  context(options: AgentHubTokenDanceFixtureContextOptions): Promise<ThreadContext>;
  createTokenDanceIdLogin(options?: Partial<AgentHubTokenDanceIdLoginOptions>): TokenDanceIdLoginRequest;
  verifyTokenDanceIdCallback(callbackUrl: string | URL | URLSearchParams, request: TokenDanceIdLoginRequest): TokenDanceIdCallbackResult;
  decideApproval(requestId: string, decision: AgentHubApprovalDecision, reason?: string): boolean;
  pendingApprovals(): AgentHubApprovalRequest[];
}

export interface AgentHubTokenDanceConsumerFixture {
  runner: AgentHubTokenDanceRunner;
  startup(options?: AgentHubTokenDanceDoctorOptions): Promise<AgentHubTokenDanceBootstrapResult>;
  login(options?: Partial<AgentHubTokenDanceIdLoginOptions>): TokenDanceIdLoginRequest;
  verifyLoginCallback(callbackUrl: string | URL | URLSearchParams, request: TokenDanceIdLoginRequest): TokenDanceIdCallbackResult;
  run(options: AgentHubTokenDanceFixtureRunOptions): Promise<TurnResult>;
  context(options: AgentHubTokenDanceFixtureContextOptions): Promise<ThreadContext>;
  events(): AgentHubAgentStreamPayload[];
  approvals(): AgentHubApprovalRequest[];
  decideApproval(requestId: string, decision: AgentHubApprovalDecision, reason?: string): boolean;
  pendingApprovals(): AgentHubApprovalRequest[];
}

export function createAgentHubTokenDanceRunner(options: AgentHubTokenDanceRunnerOptions): AgentHubTokenDanceRunner {
  const approvalBridge = options.onApprovalRequest
    ? createAgentHubApprovalBridge({
        clock: options.clock,
        async onRequest(request) {
          await approvalEmitterStorage.getStore()?.(request);
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

    async bootstrap(doctorOptions = {}) {
      return {
        packageInfo: TOKEN_DANCE_CODE_PACKAGE,
        doctor: await this.doctor(doctorOptions)
      };
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
      return approvalEmitterStorage.run((request) => emitAgentStream(toPermissionRequestedRuntimeEvent(request)), async () => {
        const thread = await resumeOrStartThread(client, runOptions, storageRoot, options.defaultPermissionMode);
        return await thread.run(runOptions.prompt);
      });
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

export function createAgentHubTokenDanceE2EFixture(options: AgentHubTokenDanceE2EFixtureOptions): AgentHubTokenDanceE2EFixture {
  const agentStream: AgentHubAgentStreamPayload[] = [];
  const approvalRequests: AgentHubApprovalRequest[] = [];
  const runner = createAgentHubTokenDanceRunner({
    provider: options.provider,
    storageRoot: options.storageRoot,
    env: options.env,
    defaultPermissionMode: options.defaultPermissionMode,
    contextMaxRecentMessages: options.contextMaxRecentMessages,
    streamIdFactory: options.streamIdFactory,
    clock: options.clock,
    async emitAgentStream(payload) {
      agentStream.push(payload);
      await options.onAgentStream?.(payload);
    },
    async onApprovalRequest(request) {
      approvalRequests.push(request);
      await options.onApprovalRequest?.(request);
    }
  });

  return {
    runner,
    agentStream,
    approvalRequests,

    async bootstrap(doctorOptions) {
      return runner.bootstrap({
        workingDirectory: options.defaultRun.workingDirectory,
        ...doctorOptions
      });
    },

    run(runOptions) {
      return runner.run({
        ...options.defaultRun,
        ...runOptions
      });
    },

    context(contextOptions) {
      return runner.context({
        workingDirectory: options.defaultRun.workingDirectory,
        sessionId: options.defaultRun.sessionId,
        permissionMode: options.defaultRun.permissionMode,
        ...contextOptions
      });
    },

    createTokenDanceIdLogin(loginOptions = {}) {
      return runner.createTokenDanceIdLogin(mergeTokenDanceIdLoginOptions(options.defaultLogin, loginOptions));
    },

    verifyTokenDanceIdCallback(callbackUrl, request) {
      return runner.verifyTokenDanceIdCallback(callbackUrl, request);
    },

    decideApproval(requestId, decision, reason) {
      return runner.decideApproval(requestId, decision, reason);
    },

    pendingApprovals() {
      return runner.pendingApprovals();
    }
  };
}

export function createAgentHubTokenDanceConsumerFixture(options: AgentHubTokenDanceConsumerFixtureOptions): AgentHubTokenDanceConsumerFixture {
  const fixture = createAgentHubTokenDanceE2EFixture(options);

  return {
    runner: fixture.runner,
    startup: fixture.bootstrap,
    login: fixture.createTokenDanceIdLogin,
    verifyLoginCallback: fixture.verifyTokenDanceIdCallback,
    run: fixture.run,
    context: fixture.context,
    events() {
      return [...fixture.agentStream];
    },
    approvals() {
      return [...fixture.approvalRequests];
    },
    decideApproval: fixture.decideApproval,
    pendingApprovals: fixture.pendingApprovals
  };
}

function mergeTokenDanceIdLoginOptions(
  defaults: Partial<AgentHubTokenDanceIdLoginOptions> | undefined,
  overrides: Partial<AgentHubTokenDanceIdLoginOptions>
): AgentHubTokenDanceIdLoginOptions {
  const merged = {
    ...defaults,
    ...overrides
  };
  if (!merged.clientId || !merged.redirectUri) {
    throw new Error("AgentHub fixture TokenDanceID login requires clientId and redirectUri via defaultLogin or createTokenDanceIdLogin().");
  }
  return {
    ...merged,
    clientId: merged.clientId,
    redirectUri: merged.redirectUri
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
