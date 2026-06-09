import { spawn } from "node:child_process";
import type { PermissionDecision, TokenUsage, ToolCall, ToolResult } from "./types.js";

export const RUNTIME_HOOK_TIMEOUT_MS = 2_000;

export type RuntimeHookEvent = "PreToolUse" | "PostToolUse" | "TurnCompleted";

export interface RuntimeHookCommand {
  event: RuntimeHookEvent;
  command: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
}

export interface RuntimeHookOptions {
  enabled?: boolean;
  commands?: RuntimeHookCommand[];
}

interface RuntimeHookPayloadBase {
  event: RuntimeHookEvent;
  sessionId: string;
  turnId: string;
  cwd: string;
}

export type RuntimeHookPayload =
  | (RuntimeHookPayloadBase & {
    event: "PreToolUse";
    toolCall: ToolCall;
    permission?: PermissionDecision;
  })
  | (RuntimeHookPayloadBase & {
    event: "PostToolUse";
    toolCall: ToolCall;
    result: ToolResult;
  })
  | (RuntimeHookPayloadBase & {
    event: "TurnCompleted";
    finalResponse: string;
    usage?: TokenUsage;
  });

export class RuntimeHookError extends Error {
  constructor(
    readonly hookEvent: RuntimeHookEvent,
    readonly command: RuntimeHookCommand,
    readonly reason: string,
    readonly output: { stdout: string; stderr: string }
  ) {
    super(`Hook ${hookEvent} failed: ${reason}`);
    this.name = "RuntimeHookError";
  }
}

export class RuntimeHookRunner {
  constructor(private readonly options?: RuntimeHookOptions) {}

  async run(payload: RuntimeHookPayload): Promise<void> {
    if (this.options?.enabled !== true) {
      return;
    }

    for (const command of this.options.commands ?? []) {
      if (command.event === payload.event) {
        await runHookCommand(command, payload);
      }
    }
  }
}

async function runHookCommand(command: RuntimeHookCommand, payload: RuntimeHookPayload): Promise<void> {
  const input = `${JSON.stringify(payload)}\n`;
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command.command, command.args ?? [], {
      cwd: command.cwd ?? payload.cwd,
      env: command.env ? { ...process.env, ...command.env } : process.env,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    let settled = false;

    const rejectOnce = (reason: string) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      reject(new RuntimeHookError(payload.event, command, reason, { stdout, stderr }));
    };

    const resolveOnce = () => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve();
    };

    const timer = setTimeout(() => {
      child.kill();
      rejectOnce(`timed out after ${RUNTIME_HOOK_TIMEOUT_MS}ms`);
    }, RUNTIME_HOOK_TIMEOUT_MS);

    child.stdout?.on("data", (chunk) => {
      stdout = truncateHookOutput(stdout + String(chunk));
    });
    child.stderr?.on("data", (chunk) => {
      stderr = truncateHookOutput(stderr + String(chunk));
    });
    child.on("error", (error) => {
      rejectOnce(`spawn error: ${error.message}`);
    });
    child.on("close", (code, signal) => {
      if (code === 0) {
        resolveOnce();
        return;
      }
      rejectOnce(signal ? `terminated by signal ${signal}` : `exited with code ${code ?? "unknown"}`);
    });
    child.stdin.on("error", (error) => {
      rejectOnce(`stdin error: ${error.message}`);
    });
    child.stdin.end(input);
  });
}

function truncateHookOutput(output: string): string {
  return output.length > 8_192 ? output.slice(-8_192) : output;
}
