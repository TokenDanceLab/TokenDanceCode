import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { access, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, extname, isAbsolute, join } from "node:path";
import type { PermissionDecision, TokenUsage, ToolCall, ToolResult } from "./types.js";

export const RUNTIME_HOOK_TIMEOUT_MS = 2_000;
export const RUNTIME_HOOK_KILL_WAIT_MS = 1_000;

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
  let spawnCommand: PreparedHookCommand;
  try {
    spawnCommand = await prepareHookCommand(command, payload.cwd, input);
  } catch (error) {
    throw new RuntimeHookError(payload.event, command, `spawn error: ${errorMessage(error)}`, { stdout: "", stderr: "" });
  }

  try {
    await new Promise<void>((resolve, reject) => {
      let child: ChildProcess;
      let stdout = "";
      let stderr = "";
      let settled = false;
      let timedOut = false;
      let killDiagnostic = "";
      let timer: ReturnType<typeof setTimeout>;
      let killWaitTimer: ReturnType<typeof setTimeout> | undefined;

      const rejectOnce = (reason: string) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        if (killWaitTimer) {
          clearTimeout(killWaitTimer);
        }
        reject(new RuntimeHookError(payload.event, command, formatFailureReason(reason, stdout, stderr), { stdout, stderr }));
      };

      const resolveOnce = () => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        if (killWaitTimer) {
          clearTimeout(killWaitTimer);
        }
        resolve();
      };

      try {
        child = spawn(spawnCommand.command, spawnCommand.args, {
          cwd: command.cwd ?? payload.cwd,
          env: command.env ? { ...process.env, ...command.env } : process.env,
          windowsHide: true,
          windowsVerbatimArguments: spawnCommand.windowsVerbatimArguments,
          stdio: [spawnCommand.stdin === "pipe" ? "pipe" : "ignore", "pipe", "pipe"]
        });
      } catch (error) {
        reject(new RuntimeHookError(payload.event, command, `spawn error: ${errorMessage(error)}`, { stdout, stderr }));
        return;
      }

      timer = setTimeout(() => {
        timedOut = true;
        void terminateProcessTree(child).then((diagnostic) => {
          killDiagnostic = diagnostic;
        }).catch((error) => {
          killDiagnostic = `kill error: ${errorMessage(error)}`;
        });
        killWaitTimer = setTimeout(() => {
          rejectOnce(`timed out after ${RUNTIME_HOOK_TIMEOUT_MS}ms; process did not close within ${RUNTIME_HOOK_KILL_WAIT_MS}ms after kill${formatKillDiagnostic(killDiagnostic)}`);
        }, RUNTIME_HOOK_KILL_WAIT_MS);
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
        if (timedOut) {
          rejectOnce(`timed out after ${RUNTIME_HOOK_TIMEOUT_MS}ms; process closed after timeout with ${closeStatus(code, signal)}${formatKillDiagnostic(killDiagnostic)}`);
          return;
        }
        if (code === 0) {
          resolveOnce();
          return;
        }
        rejectOnce(signal ? `terminated by signal ${signal}` : `exited with code ${code ?? "unknown"}`);
      });
      if (spawnCommand.stdin === "pipe") {
        child.stdin?.on("error", (error) => {
          rejectOnce(`stdin error: ${error.message}`);
        });
        child.stdin?.end(input);
      }
    });
  } finally {
    await cleanupPreparedHookCommand(spawnCommand);
  }
}

interface PreparedHookCommand {
  command: string;
  args: string[];
  stdin: "pipe" | "ignore";
  stdinFile?: string;
  windowsVerbatimArguments?: boolean;
}

async function prepareHookCommand(command: RuntimeHookCommand, cwd: string, input: string): Promise<PreparedHookCommand> {
  validateSpawnValue(command.command, "command");
  for (const [index, arg] of (command.args ?? []).entries()) {
    validateSpawnValue(arg, `args[${index}]`);
  }

  if (process.platform !== "win32") {
    return { command: command.command, args: command.args ?? [], stdin: "pipe" };
  }

  const resolved = await resolveWindowsCommand(command.command, command.cwd ?? cwd);
  if (!isWindowsBatchCommand(resolved)) {
    return { command: resolved, args: command.args ?? [], stdin: "pipe" };
  }

  const stdinFile = join(tmpdir(), `tdcode-hook-stdin-${randomUUID()}.json`);
  await writeFile(stdinFile, input, "utf8");
  return {
    command: process.env.ComSpec ?? "cmd.exe",
    args: ["/d", "/c", `${["call", quoteCmdArg(resolved), ...(command.args ?? []).map(quoteCmdArg)].join(" ")} < ${quoteCmdArg(stdinFile)}`],
    stdin: "ignore",
    stdinFile,
    windowsVerbatimArguments: true
  };
}

async function cleanupPreparedHookCommand(command: PreparedHookCommand): Promise<void> {
  if (command.stdinFile) {
    await rm(command.stdinFile, { force: true });
  }
}

function validateSpawnValue(value: string, label: string): void {
  if (value.length === 0) {
    throw new Error(`${label} must not be empty`);
  }
  if (value.includes("\0")) {
    throw new Error(`${label} must not contain null bytes`);
  }
}

async function resolveWindowsCommand(command: string, cwd: string): Promise<string> {
  if (hasPathSeparator(command) || isAbsolute(command)) {
    return await resolveExistingWindowsCommand(command, cwd) ?? command;
  }

  const searchDirs = [cwd, ...(process.env.PATH ?? "").split(delimiter).filter(Boolean)];
  for (const dir of searchDirs) {
    const resolved = await resolveExistingWindowsCommand(join(dir, command), cwd);
    if (resolved) {
      return resolved;
    }
  }
  return command;
}

async function resolveExistingWindowsCommand(command: string, cwd: string): Promise<string | undefined> {
  const base = isAbsolute(command) ? command : join(cwd, command);
  for (const candidate of windowsCommandCandidates(base)) {
    if (await fileExists(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

function windowsCommandCandidates(command: string): string[] {
  if (extname(command) !== "") {
    return [command];
  }

  const pathExt = (process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD")
    .split(";")
    .map((extension) => extension.trim())
    .filter(Boolean);
  return [command, ...pathExt.map((extension) => `${command}${extension.startsWith(".") ? extension : `.${extension}`}`)];
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function hasPathSeparator(command: string): boolean {
  return command.includes("/") || command.includes("\\");
}

function isWindowsBatchCommand(command: string): boolean {
  const extension = extname(command).toLowerCase();
  return extension === ".cmd" || extension === ".bat";
}

function quoteCmdArg(value: string): string {
  return `"${value.replaceAll("%", "%%").replaceAll('"', '\\"')}"`;
}

async function terminateProcessTree(child: ChildProcess): Promise<string> {
  if (!child.pid) {
    child.kill();
    return "no pid available; sent direct kill";
  }

  if (process.platform !== "win32") {
    child.kill();
    return "sent direct kill";
  }

  child.kill();
  return await runTaskkill(child.pid);
}

async function runTaskkill(pid: number): Promise<string> {
  return await new Promise((resolve) => {
    const killer = spawn("taskkill.exe", ["/pid", String(pid), "/t", "/f"], {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stderr = "";
    killer.stderr?.on("data", (chunk) => {
      stderr = truncateHookOutput(stderr + String(chunk));
    });
    killer.on("error", (error) => {
      resolve(`taskkill spawn error: ${error.message}`);
    });
    killer.on("close", (code, signal) => {
      if (code === 0) {
        resolve("taskkill /T /F sent");
        return;
      }
      resolve(signal ? `taskkill terminated by signal ${signal}` : `taskkill exited with code ${code ?? "unknown"}${stderr ? `: ${stderr.trim()}` : ""}`);
    });
  });
}

function closeStatus(code: number | null, signal: NodeJS.Signals | null): string {
  return signal ? `signal ${signal}` : `code ${code ?? "unknown"}`;
}

function formatKillDiagnostic(diagnostic: string): string {
  return diagnostic ? `; ${diagnostic}` : "";
}

function formatFailureReason(reason: string, stdout: string, stderr: string): string {
  const diagnostics = [
    stdout.trim() ? `stdout=${stdout.trim()}` : "",
    stderr.trim() ? `stderr=${stderr.trim()}` : ""
  ].filter(Boolean);
  return diagnostics.length > 0 ? `${reason}; ${diagnostics.join("; ")}` : reason;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function truncateHookOutput(output: string): string {
  return output.length > 8_192 ? output.slice(-8_192) : output;
}
