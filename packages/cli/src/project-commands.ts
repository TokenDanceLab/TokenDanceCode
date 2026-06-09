/**
 * Project management commands: memory, agents, diff, review, tools, quality, tasks, todo, worktree.
 */
import { TokenDanceCode, type AgentRunRecord, type MemoryScope, type PermissionMode } from "@tokendance/code-sdk";
import { write, type CliIO } from "./cli-io.js";

// --- Memory ---

export async function memoryCommand(args: string[], io: CliIO): Promise<number> {
  const memory = new TokenDanceCode().memory({ projectRoot: io.cwd() });
  const [command, rawScope, ...rest] = args;
  const scope = parseMemoryScope(rawScope);

  if (!command) {
    await printMemoryEntries(io, memory, "project");
    await printMemoryEntries(io, memory, "global");
    return 0;
  }

  if (command === "add") {
    const text = rest.join(" ").trim();
    if (!scope || !text) {
      await write(io.stderr, "Usage: tokendance memory add project|global <text>\n");
      return 1;
    }
    await memory.add(scope, text);
    await write(io.stdout, `Added ${scope} memory.\n`);
    return 0;
  }

  if (command === "delete") {
    const index = Number.parseInt(rest[0] ?? "", 10);
    if (!scope || Number.isNaN(index)) {
      await write(io.stderr, "Usage: tokendance memory delete project|global <index>\n");
      return 1;
    }
    await memory.delete(scope, index);
    await write(io.stdout, `Deleted ${scope} memory ${index}.\n`);
    return 0;
  }

  await write(io.stderr, "Usage: tokendance memory [add|delete] [project|global] [value]\n");
  return 1;
}

function parseMemoryScope(value: string | undefined): MemoryScope | undefined {
  return value === "project" || value === "global" ? value : undefined;
}

async function printMemoryEntries(io: CliIO, memory: ReturnType<TokenDanceCode["memory"]>, scope: MemoryScope): Promise<void> {
  const entries = await memory.list(scope);
  if (entries.length === 0) {
    await write(io.stdout, `No ${scope} memory.\n`);
    return;
  }
  for (const [index, entry] of entries.entries()) {
    await write(io.stdout, `${scope}[${index}]: ${entry}\n`);
  }
}

// --- Agents ---

export async function agentsCommand(args: string[], io: CliIO): Promise<number> {
  const agents = new TokenDanceCode().subagents({ projectRoot: io.cwd() });
  const [command, rawType, ...promptParts] = args;
  try {
    if (!command) {
      await printAgents(io, await agents.list());
      return 0;
    }
    if (command === "show" && rawType) {
      const agent = await agents.get(rawType);
      if (!agent) {
        await write(io.stderr, `Subagent ${rawType} was not found.\n`);
        return 1;
      }
      await printAgentDetail(io, agent);
      return 0;
    }
    if (command === "accept" && rawType) {
      const accepted = await agents.accept(rawType, {
        discardWorktree: promptParts.includes("--discard-worktree"),
        allowDirtyTarget: promptParts.includes("--allow-dirty-target")
      });
      await write(io.stdout, `Accepted subagent ${accepted.id} worktree ${accepted.worktree}.\n`);
      return 0;
    }
    if (command === "discard" && rawType) {
      const discarded = await agents.discard(rawType, { discard: promptParts.includes("--discard") });
      await write(io.stdout, `Discarded subagent ${discarded.id} worktree ${discarded.worktree}.\n`);
      return 0;
    }
    if (command === "run") {
      const parsed = parseAgentRunArgs(rawType, promptParts);
      if (!parsed) {
        await write(io.stderr, agentUsage());
        return 1;
      }
      const result = parsed.agentType === "coding"
        ? await agents.runCoding({ prompt: parsed.prompt, worktree: parsed.worktree })
        : await agents.runReadonly({ agentType: parsed.agentType, prompt: parsed.prompt });
      await write(io.stdout, `${result.id} [${result.agentType}] ${result.summary}\n`);
      if (result.worktreePath) {
        await write(io.stdout, `worktree: ${result.worktreePath}\n`);
      }
      return 0;
    }
    await write(io.stderr, agentUsage());
    return 1;
  } catch (error) {
    await write(io.stderr, `${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

function parseAgentRunArgs(rawType: string | undefined, args: string[]): { agentType: "investigator" | "reviewer" | "coding"; prompt: string; worktree?: string } | undefined {
  const readonlyType = parseReadonlyAgentType(rawType);
  if (readonlyType) {
    const prompt = args.join(" ").trim();
    return prompt ? { agentType: readonlyType, prompt } : undefined;
  }
  if (rawType !== "coding") { return undefined; }
  const worktreeFlagIndex = args.indexOf("--worktree");
  const worktree = worktreeFlagIndex >= 0 ? args[worktreeFlagIndex + 1] : undefined;
  const promptParts = worktreeFlagIndex >= 0 ? args.filter((_, index) => index !== worktreeFlagIndex && index !== worktreeFlagIndex + 1) : args;
  const prompt = promptParts.join(" ").trim();
  if (!prompt || (worktreeFlagIndex >= 0 && !worktree)) { return undefined; }
  return { agentType: "coding", prompt, worktree };
}

function parseReadonlyAgentType(value: string | undefined): "investigator" | "reviewer" | undefined {
  return value === "investigator" || value === "reviewer" ? value : undefined;
}

function agentUsage(): string {
  return "Usage: tokendance agents [show <id> | accept <id> [--discard-worktree] [--allow-dirty-target] | discard <id> [--discard] | run investigator|reviewer <prompt> | run coding [--worktree name] <prompt>]\n";
}

async function printAgents(io: CliIO, agents: Awaited<ReturnType<ReturnType<TokenDanceCode["subagents"]>["list"]>>): Promise<void> {
  if (agents.length === 0) {
    await write(io.stdout, "No subagents.\n");
    return;
  }
  for (const agent of agents) {
    const status = agent.status === "completed" ? "" : ` [${agent.status}]`;
    await write(io.stdout, `${agent.id} [${agent.agentType}]${status} ${agent.summary}\n`);
  }
}

async function printAgentDetail(io: CliIO, agent: AgentRunRecord): Promise<void> {
  await write(io.stdout, `${agent.id} [${agent.agentType}] ${agent.status}\n`);
  await write(io.stdout, `summary: ${agent.summary}\n`);
  await write(io.stdout, `readonly: ${agent.readonly}\n`);
  await write(io.stdout, `cwd: ${agent.cwd}\n`);
  if (agent.worktree) { await write(io.stdout, `worktree: ${agent.worktree}\n`); }
  if (agent.worktreePath) { await write(io.stdout, `worktreePath: ${agent.worktreePath}\n`); }
  if (agent.changedFiles.length > 0) { await write(io.stdout, `changedFiles: ${agent.changedFiles.join(", ")}\n`); }
  if (agent.validationResult) { await write(io.stdout, `validation: ${agent.validationResult}\n`); }
  await write(io.stdout, `transcript: ${agent.transcriptPath}\n`);
}

// --- Git ---

export async function diffCommand(paths: string[], io: CliIO): Promise<number> {
  const result = await new TokenDanceCode().tools({ workingDirectory: io.cwd() }).execute("git_diff", { paths });
  if (!result.ok) {
    await write(io.stderr, `${result.error ?? "git diff failed"}\n`);
    return 1;
  }
  const output = gitOutput(result.output);
  await write(io.stdout, output.stdout.trim() ? output.stdout : "No git diff.\n");
  return 0;
}

export async function reviewCommand(io: CliIO): Promise<number> {
  const result = await new TokenDanceCode().tools({ workingDirectory: io.cwd() }).execute("git_review");
  if (!result.ok) {
    await write(io.stderr, `${result.error ?? "git review failed"}\n`);
    return 1;
  }
  const findings = reviewFindings(result.output);
  if (findings.length === 0) {
    await write(io.stdout, "No review findings.\n");
    return 0;
  }
  for (const finding of findings) {
    await write(io.stdout, `[${finding.severity}] ${finding.message}\n`);
  }
  return 0;
}

export async function warnUncommittedChanges(io: CliIO): Promise<void> {
  const result = await new TokenDanceCode().tools({ workingDirectory: io.cwd() }).execute("git_status");
  if (!result.ok) { return; }
  const status = gitOutput(result.output).stdout.trim();
  if (!status) { return; }
  await write(io.stdout, "Uncommitted changes detected:\n");
  await write(io.stdout, `${status}\n`);
}

function gitOutput(output: unknown): { stdout: string; stderr: string; exitCode: number | null } {
  if (typeof output === "object" && output !== null) {
    const candidate = output as { stdout?: unknown; stderr?: unknown; exitCode?: unknown };
    return {
      stdout: typeof candidate.stdout === "string" ? candidate.stdout : "",
      stderr: typeof candidate.stderr === "string" ? candidate.stderr : "",
      exitCode: typeof candidate.exitCode === "number" || candidate.exitCode === null ? candidate.exitCode : null
    };
  }
  return { stdout: "", stderr: "", exitCode: null };
}

function reviewFindings(output: unknown): Array<{ severity: string; message: string }> {
  if (typeof output !== "object" || output === null || !Array.isArray((output as { findings?: unknown }).findings)) {
    return [];
  }
  return (output as { findings: unknown[] }).findings.flatMap((finding) => {
    if (typeof finding !== "object" || finding === null) { return []; }
    const candidate = finding as { severity?: unknown; message?: unknown };
    if (typeof candidate.severity !== "string" || typeof candidate.message !== "string") { return []; }
    return [{ severity: candidate.severity, message: candidate.message }];
  });
}

// --- Tools ---

export async function toolsCommand(io: CliIO): Promise<number> {
  await printToolMetadata(io, new TokenDanceCode().tools({ workingDirectory: io.cwd() }));
  return 0;
}

async function printToolMetadata(io: CliIO, tools: import("@tokendance/code-sdk").TokenDanceTools): Promise<void> {
  for (const tool of tools.list()) {
    await write(io.stdout, `[${tool.risk}/${tool.concurrency}] ${tool.name} - ${tool.description}\n`);
  }
}

// --- Quality ---

export async function qualityCommand(args: string[], io: CliIO): Promise<number> {
  const format = qualityFormat(args);
  const command = stripQualityFormatArgs(args).join(" ").trim();

  const result = await new TokenDanceCode()
    .tools({ workingDirectory: io.cwd() })
    .execute("quality_gate", command ? { command, timeout: 60 } : { timeout: 60 }, { permissionMode: "yolo" });
  if (!result.ok) {
    await write(io.stderr, `${result.error ?? "quality failed"}\n`);
    return 1;
  }

  const quality = qualityOutput(result.output);
  if (format === "json") {
    await write(io.stdout, `${JSON.stringify(quality, null, 2)}\n`);
    return quality.passed ? 0 : 1;
  }

  await write(io.stdout, quality.passed ? "Quality passed.\n" : "Quality failed.\n");
  if (quality.result.stdout.trim()) { await write(io.stdout, quality.result.stdout); }
  if (quality.result.stderr.trim()) { await write(io.stderr, quality.result.stderr); }
  return quality.passed ? 0 : 1;
}

function qualityFormat(args: string[]): "text" | "json" {
  return args[0] === "--json" || args[0] === "json" ? "json" : "text";
}

function stripQualityFormatArgs(args: string[]): string[] {
  return qualityFormat(args) === "json" ? args.slice(1) : args;
}

function qualityOutput(output: unknown): { passed: boolean; result: { stdout: string; stderr: string; exitCode: number | null } } {
  if (typeof output === "object" && output !== null) {
    const candidate = output as { passed?: unknown; result?: unknown };
    return { passed: candidate.passed === true, result: gitOutput(candidate.result) };
  }
  return { passed: false, result: { stdout: "", stderr: "", exitCode: null } };
}

// --- Tasks ---

export async function tasksCommand(args: string[], io: CliIO): Promise<number> {
  const tasks = new TokenDanceCode().tasks({ projectRoot: io.cwd() });
  const [command, id, ...rest] = args;
  try {
    if (!command) {
      await printTasks(io, await tasks.list());
      return 0;
    }
    if (command === "create") {
      const title = [id, ...rest].filter(Boolean).join(" ").trim();
      if (!title) {
        await write(io.stderr, "Usage: tokendance tasks create <title>\n");
        return 1;
      }
      const task = await tasks.create({ title });
      await write(io.stdout, `Created task ${task.id}.\n`);
      return 0;
    }
    if (command === "done" && id) {
      const task = await tasks.updateStatus(id, "completed");
      await write(io.stdout, `Updated task ${task.id} to ${task.status}.\n`);
      return 0;
    }
    if (command === "doing" && id) {
      const task = await tasks.updateStatus(id, "in_progress");
      await write(io.stdout, `Updated task ${task.id} to ${task.status}.\n`);
      return 0;
    }
    if (command === "link-session") {
      const sessionId = rest.join(" ").trim();
      if (!id || !sessionId) {
        await write(io.stderr, "Usage: tokendance tasks link-session <task-id> <session-id>\n");
        return 1;
      }
      const task = await tasks.linkSession(id, sessionId);
      await write(io.stdout, `Linked task ${task.id} to session ${task.linkedSessionId}.\n`);
      return 0;
    }
    if (command === "link-worktree") {
      const worktree = rest.join(" ").trim();
      if (!id || !worktree) {
        await write(io.stderr, "Usage: tokendance tasks link-worktree <task-id> <worktree>\n");
        return 1;
      }
      const task = await tasks.linkWorktree(id, worktree);
      await write(io.stdout, `Linked task ${task.id} to worktree ${task.linkedWorktree}.\n`);
      return 0;
    }
    await write(io.stderr, "Usage: tokendance tasks [create|doing|done|link-session|link-worktree] [value]\n");
    return 1;
  } catch (error) {
    await write(io.stderr, `${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

async function printTasks(io: CliIO, tasks: Awaited<ReturnType<ReturnType<TokenDanceCode["tasks"]>["list"]>>): Promise<void> {
  if (tasks.length === 0) {
    await write(io.stdout, "No tasks.\n");
    return;
  }
  for (const task of tasks) {
    const linked = [task.linkedSessionId ? `session ${task.linkedSessionId}` : "", task.linkedWorktree ? `worktree ${task.linkedWorktree}` : ""]
      .filter(Boolean).join(", ");
    await write(io.stdout, `[${task.status}] ${task.id} ${task.title}${linked ? ` (${linked})` : ""}\n`);
  }
}

// --- Todo ---

export async function todoCommand(args: string[], io: CliIO): Promise<number> {
  const todos = new TokenDanceCode().todos({ projectRoot: io.cwd() });
  const [command, id, ...rest] = args;
  try {
    if (!command) {
      await printTodos(io, await todos.list());
      return 0;
    }
    if (command === "add") {
      const { text, taskId } = parseTodoAddArgs(id ? [id, ...rest] : rest);
      if (!text) {
        await write(io.stderr, "Usage: tokendance todo add <text> [--task task-id]\n");
        return 1;
      }
      const todo = await todos.add({ text, taskId });
      await write(io.stdout, `Created todo ${todo.id}.\n`);
      return 0;
    }
    if (command === "done" && id) {
      const todo = await todos.updateStatus(id, "completed");
      await write(io.stdout, `Updated todo ${todo.id} to ${todo.status}.\n`);
      return 0;
    }
    if (command === "doing" && id) {
      const todo = await todos.updateStatus(id, "in_progress");
      await write(io.stdout, `Updated todo ${todo.id} to ${todo.status}.\n`);
      return 0;
    }
    await write(io.stderr, "Usage: tokendance todo [add|doing|done] [value]\n");
    return 1;
  } catch (error) {
    await write(io.stderr, `${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

function parseTodoAddArgs(args: string[]): { text: string; taskId?: string } {
  const taskFlagIndex = args.indexOf("--task");
  if (taskFlagIndex < 0) { return { text: args.join(" ").trim() }; }
  return { text: args.slice(0, taskFlagIndex).join(" ").trim(), taskId: args[taskFlagIndex + 1] };
}

async function printTodos(io: CliIO, todos: Awaited<ReturnType<ReturnType<TokenDanceCode["todos"]>["list"]>>): Promise<void> {
  if (todos.length === 0) {
    await write(io.stdout, "No todos.\n");
    return;
  }
  for (const todo of todos) {
    await write(io.stdout, `[${todo.status}] ${todo.id} ${todo.text}${todo.taskId ? ` (task ${todo.taskId})` : ""}\n`);
  }
}

// --- Worktree ---

export async function worktreeCommand(args: string[], io: CliIO): Promise<number> {
  const worktrees = new TokenDanceCode().worktrees({ repositoryRoot: io.cwd() });
  const [command, name, ...rest] = args;
  try {
    if (!command || command === "list") {
      await printWorktrees(io, await worktrees.list());
      return 0;
    }
    if (command === "create" && name) {
      const worktree = await worktrees.create({ name });
      await write(io.stdout, `Created worktree ${worktree.name}.\n`);
      await write(io.stdout, `${worktree.path}\n`);
      return 0;
    }
    if (command === "remove" && name) {
      await worktrees.remove(name, { discard: rest.includes("--discard") });
      await write(io.stdout, `Removed worktree ${name}.\n`);
      return 0;
    }
    await write(io.stderr, "Usage: tokendance worktree [list|create|remove] [name] [--discard]\n");
    return 1;
  } catch (error) {
    await write(io.stderr, `${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

async function printWorktrees(io: CliIO, worktrees: Awaited<ReturnType<ReturnType<TokenDanceCode["worktrees"]>["list"]>>): Promise<void> {
  if (worktrees.length === 0) {
    await write(io.stdout, "No worktrees.\n");
    return;
  }
  for (const worktree of worktrees) {
    await write(io.stdout, `[${worktree.branch ?? "detached"}] ${worktree.name} ${worktree.path}\n`);
  }
}
