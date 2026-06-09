import { spawn } from "node:child_process";
import { createShellCommandPermissionSubject } from "./permissions.js";
import { classifyPowerShellCommandWithReason } from "./powershell.js";
import type { ToolSafetyEvidence, ToolSpec } from "./types.js";

interface RunPowerShellInput {
  command: string;
  timeoutMs: number;
}

export interface CommandResult {
  command: string;
  exitCode: number | null;
  durationMs: number;
  timedOut: boolean;
  stdout: string;
  stderr: string;
}

export function createRunPowerShellTool(): ToolSpec<RunPowerShellInput, CommandResult> {
  return {
    name: "run_powershell",
    description: "Run a PowerShell command in the workspace.",
    risk: "shell",
    concurrency: "exclusive",
    safetyNotes: ["PowerShell classifier hard-denies destructive commands before execution."],
    parse(input) {
      if (typeof input !== "object" || input === null || typeof (input as { command?: unknown }).command !== "string") {
        throw new Error("run_powershell input requires a string command field");
      }
      const timeout = (input as { timeout?: unknown; timeoutMs?: unknown }).timeoutMs ?? (input as { timeout?: unknown }).timeout;
      if (timeout !== undefined && typeof timeout !== "number") {
        throw new Error("run_powershell timeout must be a number");
      }
      return {
        command: (input as { command: string }).command,
        timeoutMs: Math.max(1, Math.floor((timeout ?? 60) * 1000))
      };
    },
    permissionSubjects(input) {
      return [createShellCommandPermissionSubject(input.command)];
    },
    async execute(input, context) {
      return runPowerShell(input.command, context.cwd, input.timeoutMs);
    }
  };
}

export async function runPowerShell(command: string, cwd: string, timeoutMs: number): Promise<CommandResult> {
  assertPowerShellCommandAllowed(command);
  const started = Date.now();
  const executable = process.platform === "win32" ? "powershell.exe" : "pwsh";

  return new Promise((resolvePromise, reject) => {
    const child = spawn(executable, ["-NoProfile", "-NonInteractive", "-Command", command], {
      cwd,
      windowsHide: true
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;

    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      clearTimeout(timeout);
      if (!settled) {
        settled = true;
        reject(error);
      }
    });
    child.on("close", (exitCode) => {
      clearTimeout(timeout);
      if (settled) {
        return;
      }
      settled = true;
      resolvePromise({
        command,
        exitCode,
        durationMs: Date.now() - started,
        timedOut,
        stdout: truncate(stdout),
        stderr: truncate(stderr)
      });
    });
  });
}

function truncate(value: string, maxLength = 12_000): string {
  if (value.length <= maxLength) {
    return value;
  }
  return `${value.slice(0, maxLength)}\n...[truncated ${value.length - maxLength} chars]`;
}

function assertPowerShellCommandAllowed(command: string): void {
  const classification = classifyPowerShellCommandWithReason(command);
  if (classification.level !== "deny") {
    return;
  }
  const error = new Error(`Tool execution denied by PowerShell risk classifier: ${classification.reason}`) as Error & {
    safetySource: ToolSafetyEvidence["source"];
    safetyStatus: ToolSafetyEvidence["status"];
    safetyReason: string;
    safetyEvidence?: ToolSafetyEvidence["evidence"];
  };
  error.safetySource = "powershell_classifier";
  error.safetyStatus = "denied";
  error.safetyReason = classification.reason;
  error.safetyEvidence = classification.evidence;
  throw error;
}
