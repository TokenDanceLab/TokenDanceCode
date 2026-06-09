import type {
  PermissionApprovalResponse,
  PermissionDecision,
  PermissionDecisionAction,
  PermissionMode,
  PermissionProfileMetadata,
  PermissionRiskMetadata,
  PermissionSubject,
  PermissionSubjectFlag,
  PermissionSubjectMetadata,
  ToolSpec
} from "./types.js";

export class PermissionEngine {
  constructor(private readonly mode: PermissionMode) {}

  static describeProfiles(tool: ToolSpec): Record<PermissionMode, PermissionProfileMetadata> {
    return Object.fromEntries(
      permissionModes.map((mode) => {
        const decision = new PermissionEngine(mode).decide(tool);
        return [
          mode,
          {
            status: decision.status,
            reason: decision.reason,
            riskMetadata: decision.riskMetadata
          }
        ];
      })
    ) as Record<PermissionMode, PermissionProfileMetadata>;
  }

  decide(tool: ToolSpec): PermissionDecision {
    if (this.mode === "yolo") {
      return allowed(this.mode, tool, "yolo mode allows registered tools; tool execution guards may still hard-deny unsafe inputs");
    }

    if (this.mode === "auto") {
      return tool.risk === "dangerous"
        ? requiresApproval(this.mode, tool, "auto mode requires approval before running dangerous tools")
        : allowed(this.mode, tool, "auto mode allows non-dangerous registered tools");
    }

    if (this.mode === "safe") {
      return tool.risk === "read"
        ? allowed(this.mode, tool, "safe mode allows read-only tools")
        : denied(this.mode, tool, "safe mode only allows read-only tools");
    }

    return tool.risk === "read"
      ? allowed(this.mode, tool, "default mode allows read-only tools")
      : requiresApproval(this.mode, tool, `default mode requires approval before running ${tool.risk} tools`);
  }

  decideSubject(tool: ToolSpec, subject: PermissionSubject): PermissionDecision {
    if (subject.flags.includes("workspace_escape")) {
      return denied(this.mode, tool, "resolved path escapes the workspace", subject);
    }

    if (subject.flags.includes("secret_like")) {
      const detail = subject.kind === "shell_command"
        ? "secret-like command input requires approval before execution"
        : "secret-like path requires approval before access";
      return this.mode === "safe"
        ? denied(this.mode, tool, detail, subject)
        : requiresApproval(this.mode, tool, detail, subject);
    }

    return allowed(this.mode, tool, "permission subject does not add risk", subject);
  }
}

const permissionModes = ["default", "safe", "auto", "yolo"] as const satisfies readonly PermissionMode[];

export function normalizeApprovalDecision(
  baseDecision: Extract<PermissionDecision, { status: "requires_approval" }>,
  response: PermissionApprovalResponse
): PermissionDecision {
  if (typeof response === "boolean") {
    return response
      ? approvalDecision(baseDecision, "allowed", `approved by callback: ${baseDecision.reason}`)
      : approvalDecision(baseDecision, "denied", `denied by callback: ${baseDecision.reason}`);
  }

  if (response.status === "allowed") {
    return approvalDecision(baseDecision, "allowed", response.reason);
  }
  if (response.status === "denied") {
    return approvalDecision(baseDecision, "denied", response.reason);
  }
  return approvalDecision(baseDecision, "denied", `denied by callback: unresolved approval response: ${response.reason}`);
}

export function reconcilePermissionDecision(baseDecision: PermissionDecision, overrideDecision?: PermissionDecision): PermissionDecision {
  if (baseDecision.status !== "requires_approval") {
    return baseDecision;
  }
  return overrideDecision ?? baseDecision;
}

export function createShellCommandPermissionSubject(command: string): PermissionSubject {
  return {
    kind: "shell_command",
    command,
    flags: isSecretLikeCommand(command) ? ["secret_like"] : []
  };
}

export function isSecretLikePath(path: string): boolean {
  const normalized = path.split("\\").join("/").toLowerCase();
  return normalized
    .split("/")
    .some((part) => isSecretLikePathPart(part));
}

function isSecretLikeCommand(command: string): boolean {
  return command
    .split(/[\s="'`|;&<>()[\]{}]+/u)
    .filter(Boolean)
    .some((part) => isSecretLikePath(part));
}

function isSecretLikePathPart(part: string): boolean {
  return /^\.env(?:\.|$)/u.test(part)
    || /(?:^|[._-])(?:secret|secrets|credential|credentials|private)(?:[._-]|$)/u.test(part)
    || /(?:^|[._-])token(?:[._-]|$)/u.test(part)
    || /^(?:id_rsa|id_dsa|id_ecdsa|id_ed25519)$/u.test(part)
    || /\.(?:pem|key|p12|pfx)$/u.test(part);
}

function allowed(mode: PermissionMode, tool: ToolSpec, detail: string, subject?: PermissionSubject): PermissionDecision {
  return {
    status: "allowed",
    reason: reason(mode, tool, "allowed", detail, subject),
    riskMetadata: riskMetadata(mode, tool, "allowed", subject)
  };
}

function denied(mode: PermissionMode, tool: ToolSpec, detail: string, subject?: PermissionSubject): PermissionDecision {
  return {
    status: "denied",
    reason: reason(mode, tool, "denied", detail, subject),
    riskMetadata: riskMetadata(mode, tool, "denied", subject)
  };
}

function requiresApproval(mode: PermissionMode, tool: ToolSpec, detail: string, subject?: PermissionSubject): PermissionDecision {
  return {
    status: "requires_approval",
    reason: reason(mode, tool, "approval_required", detail, subject),
    riskMetadata: riskMetadata(mode, tool, "approval_required", subject)
  };
}

function reason(mode: PermissionMode, tool: ToolSpec, action: PermissionDecisionAction, detail: string, subject?: PermissionSubject): string {
  if (subject) {
    return `mode=${mode} tool=${tool.name} risk=${tool.risk} action=${action} subject=${subjectLabel(subject)}: ${detail}`;
  }
  const safetyNotes = tool.safetyNotes ?? [];
  const auditContext = safetyNotes.length > 0
    ? `; concurrency=${tool.concurrency}; safety=${safetyNotes.join(" ")}`
    : "";
  return `mode=${mode} tool=${tool.name} risk=${tool.risk} action=${action}: ${detail}${auditContext}`;
}

function riskMetadata(mode: PermissionMode, tool: ToolSpec, action: PermissionDecisionAction, subject?: PermissionSubject): PermissionRiskMetadata {
  return {
    mode,
    toolName: tool.name,
    toolRisk: tool.risk,
    action,
    approvalScope: action === "approval_required" ? "tool_call" : "none",
    concurrency: tool.concurrency,
    safetyNotes: [...(tool.safetyNotes ?? [])],
    subject: subject ? subjectMetadata(subject) : undefined
  };
}

function subjectLabel(subject: PermissionSubject): string {
  if (subject.kind === "path") {
    return `path:${subject.normalizedPath || subject.rawPath}`;
  }
  return `shell_command:${commandPreview(subject.command)}`;
}

function subjectMetadata(subject: PermissionSubject): PermissionSubjectMetadata {
  if (subject.kind === "path") {
    return {
      kind: "path",
      operation: subject.operation,
      raw: subject.rawPath,
      normalized: subject.normalizedPath,
      real: subject.realPath,
      flags: [...subject.flags]
    };
  }
  return {
    kind: "shell_command",
    commandPreview: commandPreview(subject.command),
    flags: [...subject.flags]
  };
}

function commandPreview(command: string): string {
  return command.length > 120 ? `${command.slice(0, 120)}...` : command;
}

function approvalDecision(
  baseDecision: Extract<PermissionDecision, { status: "requires_approval" }>,
  status: "allowed" | "denied",
  reason: string
): PermissionDecision {
  return {
    status,
    reason,
    riskMetadata: baseDecision.riskMetadata
      ? {
          ...baseDecision.riskMetadata,
          action: status,
          approvalScope: "none"
        }
      : undefined
  };
}
