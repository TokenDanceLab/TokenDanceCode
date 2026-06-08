import { PermissionEngine } from "./permissions.js";
import { buildFileTools } from "./file-tools.js";
import { createApplyPatchTool } from "./patch-tools.js";
import { createRunPowerShellTool } from "./shell-tools.js";
import type { SessionState, ToolCall, ToolResult, ToolSpec } from "./types.js";

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
}

export class ToolOrchestrator {
  constructor(private readonly registry: ToolRegistry) {}

  async execute(call: ToolCall, session: SessionState): Promise<ToolResult> {
    const tool = this.registry.get(call.name);
    if (!tool) {
      return { callId: call.id, toolName: call.name, ok: false, error: `Unknown tool: ${call.name}` };
    }

    const decision = new PermissionEngine(session.permissionMode).decide(tool);
    if (decision.status !== "allowed") {
      return { callId: call.id, toolName: call.name, ok: false, error: decision.reason };
    }

    try {
      const input = tool.parse(call.input);
      const output = await tool.execute(input, { session, cwd: session.cwd });
      return { callId: call.id, toolName: call.name, ok: true, output };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { callId: call.id, toolName: call.name, ok: false, error: message };
    }
  }
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

export function createDefaultToolRegistry(): ToolRegistry {
  const registry = new ToolRegistry().register(createEchoTool());
  for (const tool of buildFileTools()) {
    registry.register(tool);
  }
  registry.register(createApplyPatchTool());
  registry.register(createRunPowerShellTool());
  return registry;
}
