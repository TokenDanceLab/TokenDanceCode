export type Role = "system" | "user" | "assistant" | "tool";

export interface TDMessage {
  role: Role;
  content: string;
  toolCallId?: string;
}

export type PermissionMode = "default" | "safe" | "auto" | "yolo";
export type ToolRisk = "read" | "write" | "shell" | "network" | "dangerous";

export interface ToolSpec<TInput = unknown, TOutput = unknown> {
  name: string;
  description: string;
  inputSchema?: JsonSchemaObject;
  risk: ToolRisk;
  concurrency: "serial" | "parallel_safe" | "exclusive";
  safetyNotes?: string[];
  parse(input: unknown): TInput;
  permissionSubjects?(input: TInput, context: ToolExecutionContext): PermissionSubject[] | Promise<PermissionSubject[]>;
  execute(input: TInput, context: ToolExecutionContext): Promise<TOutput>;
}

export interface JsonSchemaObject {
  type: string;
  properties?: Record<string, JsonSchemaObject>;
  required?: string[];
  additionalProperties?: boolean;
  description?: string;
  enum?: string[];
  items?: JsonSchemaObject;
}

export interface ToolExecutionContext {
  session: SessionState;
  cwd: string;
}

export interface ToolCall {
  id: string;
  name: string;
  input: unknown;
}

export type PermissionDecisionAction = "allowed" | "denied" | "approval_required";
export type PermissionSubjectFlag = "secret_like" | "workspace_escape";

export type PermissionSubject =
  | {
      kind: "path";
      operation: "read" | "write" | "edit" | "glob";
      rawPath: string;
      normalizedPath: string;
      realPath?: string;
      flags: PermissionSubjectFlag[];
    }
  | {
      kind: "shell_command";
      command: string;
      flags: PermissionSubjectFlag[];
    };

export type PermissionSubjectMetadata =
  | {
      kind: "path";
      operation: Extract<PermissionSubject, { kind: "path" }>["operation"];
      raw: string;
      normalized: string;
      real?: string;
      flags: PermissionSubjectFlag[];
    }
  | {
      kind: "shell_command";
      commandPreview: string;
      flags: PermissionSubjectFlag[];
    };

export interface PermissionRiskMetadata {
  mode: PermissionMode;
  toolName: string;
  toolRisk: ToolRisk;
  action: PermissionDecisionAction;
  approvalScope: "none" | "tool_call";
  concurrency: ToolSpec["concurrency"];
  safetyNotes: string[];
  subject?: PermissionSubjectMetadata;
}

export type PermissionDecision =
  | { status: "allowed"; reason: string; riskMetadata?: PermissionRiskMetadata }
  | { status: "denied"; reason: string; riskMetadata?: PermissionRiskMetadata }
  | { status: "requires_approval"; reason: string; riskMetadata?: PermissionRiskMetadata };

export interface PermissionProfileMetadata {
  status: PermissionDecision["status"];
  reason: string;
  riskMetadata: PermissionRiskMetadata | undefined;
}

export interface ToolSafetyEvidenceDetail {
  rule: string;
  matched: string;
  commandPreview: string;
}

export interface ToolSafetyEvidence {
  toolName: string;
  source: "permission_engine" | "powershell_classifier";
  status: "denied" | "requires_approval";
  reason: string;
  decision?: PermissionDecision;
  evidence?: ToolSafetyEvidenceDetail;
}

export interface ToolResult {
  callId: string;
  toolName: string;
  ok: boolean;
  output?: unknown;
  error?: string;
  safetyEvidence?: ToolSafetyEvidence;
}

export interface ModelTurnRequest {
  session: SessionState;
  tools: ToolSpec[];
  toolResults: ToolResult[];
}

export interface ModelTurnResponse {
  assistantMessage?: string;
  toolCalls: ToolCall[];
  usage?: TokenUsage;
}

export interface ModelProvider {
  createTurn(request: ModelTurnRequest): Promise<ModelTurnResponse>;
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface SessionState {
  id: string;
  cwd: string;
  createdAt: string;
  updatedAt: string;
  permissionMode: PermissionMode;
  messages: TDMessage[];
  compactSummary?: string;
}

export interface PermissionApprovalRequest {
  session: SessionState;
  turnId: string;
  call: ToolCall;
  tool: ToolSpec;
  decision: Extract<PermissionDecision, { status: "requires_approval" }>;
}

export type PermissionApprovalResponse = boolean | PermissionDecision;

export type PermissionApprovalCallback = (
  request: PermissionApprovalRequest
) => PermissionApprovalResponse | Promise<PermissionApprovalResponse>;

export type TDCodeEventSink = (event: TDCodeEvent) => void | Promise<void>;

export type TDCodeEvent =
  | { type: "session.created"; session: SessionState }
  | { type: "user.message"; sessionId: string; turnId: string; message: TDMessage }
  | { type: "assistant.delta"; sessionId: string; turnId: string; text: string }
  | { type: "assistant.completed"; sessionId: string; turnId: string; message: TDMessage }
  | { type: "tool.started"; sessionId: string; turnId: string; call: ToolCall }
  | { type: "tool.permission"; sessionId: string; turnId: string; call: ToolCall; decision: PermissionDecision }
  | { type: "tool.completed"; sessionId: string; turnId: string; result: ToolResult }
  | { type: "turn.completed"; sessionId: string; turnId: string; finalResponse: string; usage?: TokenUsage }
  | { type: "turn.failed"; sessionId: string; turnId: string; error: string };

export interface TranscriptEnvelope {
  version: 1;
  seq: number;
  uuid: string;
  parentUuid?: string;
  timestamp: string;
  sessionId: string;
  turnId?: string;
  cwd: string;
  event: TDCodeEvent;
}

export interface TranscriptStore {
  initialize(session: SessionState): Promise<void>;
  append(event: TDCodeEvent): Promise<void>;
  loadSession(sessionId: string): Promise<SessionState>;
  saveSession?(session: SessionState): Promise<void>;
}
