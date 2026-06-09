import { PermissionEngine, reconcilePermissionDecision } from "./permissions.js";
import { buildSubagentTools } from "./agents.js";
import { buildFileTools } from "./file-tools.js";
import { buildGitTools } from "./git-tools.js";
import { createApplyPatchTool } from "./patch-tools.js";
import { createRunPowerShellTool } from "./shell-tools.js";
import { buildWorktreeTools } from "./worktrees.js";
import type { PermissionDecision, PermissionMode, PermissionProfileMetadata, PermissionRiskMetadata, SessionState, ToolCall, ToolResult, ToolSafetyEvidence, ToolSpec, ToolRisk } from "./types.js";

export interface ToolMetadata {
  name: string;
  description: string;
  risk: ToolRisk;
  riskSummary: string;
  concurrency: ToolSpec["concurrency"];
  permissionProfiles: Record<PermissionMode, PermissionProfileMetadata>;
  permission: Record<PermissionMode, PermissionDecision["status"]>;
  permissionReasons: Record<PermissionMode, string>;
  permissionRiskMetadata: Record<PermissionMode, PermissionRiskMetadata | undefined>;
  safetyNotes: string[];
}

export class ToolRegistry {
  private readonly tools = new Map<string, ToolSpec>();

  register(tool: ToolSpec): this {
    if (this.tools.has(tool.name)) {
      throw new Error(`Tool already registered: ${tool.name}`);
    }
    this.tools.set(tool.name, tool);
    return this;
  }

  get(name: string): ToolSpec | undefined {
    return this.tools.get(name);
  }

  list(): ToolSpec[] {
    return [...this.tools.values()];
  }

  metadata(): ToolMetadata[] {
    return this.list().map((tool) => {
      const profiles = PermissionEngine.describeProfiles(tool);
      return {
        name: tool.name,
        description: tool.description,
        risk: tool.risk,
        riskSummary: riskSummary(tool.risk),
        concurrency: tool.concurrency,
        permissionProfiles: profiles,
        permission: permissionMetadata(profiles),
        permissionReasons: permissionReasonMetadata(profiles),
        permissionRiskMetadata: permissionRiskMetadata(profiles),
        safetyNotes: tool.safetyNotes ?? []
      };
    });
  }
}

export class ToolOrchestrator {
  constructor(private readonly registry: ToolRegistry) {}

  async execute(call: ToolCall, session: SessionState, permissionDecision?: PermissionDecision): Promise<ToolResult> {
    const tool = this.registry.get(call.name);
    if (!tool) {
      return { callId: call.id, toolName: call.name, ok: false, error: `Unknown tool: ${call.name}` };
    }

    const baseDecision = await decideToolCallPermission(tool, call, session);
    const decision = reconcilePermissionDecision(baseDecision, permissionDecision);
    if (decision.status !== "allowed") {
      return {
        callId: call.id,
        toolName: call.name,
        ok: false,
        error: decision.reason,
        safetyEvidence: permissionSafetyEvidence(call.name, decision)
      };
    }

    try {
      const input = tool.parse(call.input);
      const context = { session, cwd: session.cwd };
      const output = await tool.execute(input, context);
      return { callId: call.id, toolName: call.name, ok: true, output };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const safetyEvidence = toolSafetyEvidence(call.name, error);
      return { callId: call.id, toolName: call.name, ok: false, error: message, safetyEvidence };
    }
  }
}

export async function decideToolCallPermission(tool: ToolSpec, call: ToolCall, session: SessionState): Promise<PermissionDecision> {
  const engine = new PermissionEngine(session.permissionMode);
  const baseDecision = engine.decide(tool);
  if (baseDecision.status === "denied" || !tool.permissionSubjects) {
    return baseDecision;
  }

  let subjects;
  try {
    const input = tool.parse(call.input);
    subjects = await tool.permissionSubjects(input, { session, cwd: session.cwd });
  } catch {
    return baseDecision;
  }

  let firstApproval: PermissionDecision | undefined;
  for (const subject of subjects) {
    const subjectDecision = engine.decideSubject(tool, subject);
    if (subjectDecision.status === "denied") {
      return subjectDecision;
    }
    if (subjectDecision.status === "requires_approval" && !firstApproval) {
      firstApproval = subjectDecision;
    }
  }

  return firstApproval ?? baseDecision;
}

export function createEchoTool(): ToolSpec<{ text: string }, { text: string }> {
  return {
    name: "echo",
    description: "Return text unchanged. Used for runtime and SDK smoke tests.",
    risk: "read",
    concurrency: "parallel_safe",
    parse(input) {
      if (typeof input !== "object" || input === null || typeof (input as { text?: unknown }).text !== "string") {
        throw new Error("echo input requires a string text field");
      }
      return { text: (input as { text: string }).text };
    },
    async execute(input) {
      return input;
    }
  };
}

function permissionMetadata(profiles: Record<PermissionMode, PermissionProfileMetadata>): Record<PermissionMode, PermissionDecision["status"]> {
  return Object.fromEntries(permissionModes.map((mode) => [mode, profiles[mode].status])) as Record<PermissionMode, PermissionDecision["status"]>;
}

function permissionReasonMetadata(profiles: Record<PermissionMode, PermissionProfileMetadata>): Record<PermissionMode, string> {
  return Object.fromEntries(permissionModes.map((mode) => [mode, profiles[mode].reason])) as Record<PermissionMode, string>;
}

function permissionRiskMetadata(profiles: Record<PermissionMode, PermissionProfileMetadata>): Record<PermissionMode, PermissionRiskMetadata | undefined> {
  return Object.fromEntries(permissionModes.map((mode) => [mode, profiles[mode].riskMetadata])) as Record<PermissionMode, PermissionRiskMetadata | undefined>;
}

const permissionModes = ["default", "safe", "auto", "yolo"] as const satisfies readonly PermissionMode[];

function riskSummary(risk: ToolRisk): string {
  switch (risk) {
    case "read":
      return "Read-only tool: inspects workspace state without writing.";
    case "write":
      return "Write tool: can modify workspace files or state.";
    case "shell":
      return "Shell tool: executes local commands and is approval-gated outside yolo mode.";
    case "network":
      return "Network tool: can contact external services.";
    case "dangerous":
      return "Dangerous tool: high-impact action requiring explicit approval outside yolo mode.";
  }
}

function permissionSafetyEvidence(toolName: string, decision: Exclude<PermissionDecision, { status: "allowed" }>): ToolSafetyEvidence {
  return {
    toolName,
    source: "permission_engine",
    status: decision.status,
    reason: decision.reason,
    decision
  };
}

function toolSafetyEvidence(toolName: string, error: unknown): ToolSafetyEvidence | undefined {
  if (!isToolSafetyDenial(error)) {
    return undefined;
  }
  return {
    toolName,
    source: error.safetySource,
    status: error.safetyStatus,
    reason: error.safetyReason,
    evidence: error.safetyEvidence
  };
}

function isToolSafetyDenial(error: unknown): error is Error & {
  safetySource: ToolSafetyEvidence["source"];
  safetyStatus: ToolSafetyEvidence["status"];
  safetyReason: string;
  safetyEvidence?: ToolSafetyEvidence["evidence"];
} {
  return error instanceof Error
    && "safetySource" in error
    && "safetyStatus" in error
    && "safetyReason" in error
    && typeof (error as { safetyReason?: unknown }).safetyReason === "string";
}

export function createDefaultToolRegistry(): ToolRegistry {
  const registry = new ToolRegistry().register(createEchoTool());
  for (const tool of buildFileTools()) {
    registry.register(tool);
  }
  for (const tool of buildGitTools()) {
    registry.register(tool);
  }
  for (const tool of buildWorktreeTools()) {
    registry.register(tool);
  }
  for (const tool of buildSubagentTools()) {
    registry.register(tool);
  }
  registry.register(createApplyPatchTool());
  registry.register(createRunPowerShellTool());
  return registry;
}
