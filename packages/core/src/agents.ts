import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import type { ToolSpec } from "./types.js";
import { DirtyWorktreeError, WorktreeManager, parseGitStatusFiles } from "./worktrees.js";

const execFileAsync = promisify(execFile);

export type AgentType = "investigator" | "reviewer" | "coding";

export interface SubagentRequest {
  id: string;
  agentType: AgentType;
  prompt: string;
  cwd: string;
  eventLogPath: string;
  /** @deprecated Use eventLogPath. Subagent logs are not session transcript envelopes. */
  transcriptPath: string;
  readonly: boolean;
  worktree?: string;
  taskId?: string;
}

export interface SubagentOutput {
  summary?: string;
  changedFiles?: string[];
  diff?: string;
  validationResult?: string;
}

export interface AgentRunRecord {
  id: string;
  agentType: AgentType;
  prompt: string;
  summary: string;
  status: "completed" | "accepted" | "discarded";
  readonly: boolean;
  cwd: string;
  eventLogPath: string;
  /** @deprecated Use eventLogPath. Subagent logs are not session transcript envelopes. */
  transcriptPath: string;
  changedFiles: string[];
  diff: string;
  validationResult: string;
  worktreeDirty: boolean;
  worktreeDirtyFiles: string[];
  taskId?: string;
  worktree?: string;
  worktreePath?: string;
  createdAt: string;
  updatedAt: string;
}

export type SubagentRunner = (request: SubagentRequest) => SubagentOutput | Promise<SubagentOutput>;

export interface AgentManagerOptions {
  projectRoot: string;
  runner?: SubagentRunner;
  worktreeManager?: WorktreeManager;
}

export interface AgentManagerMetadata {
  projectRoot: string;
  runCount: number;
  readonlyCount: number;
  codingCount: number;
  completedCount: number;
  acceptedCount: number;
  discardedCount: number;
  dirtyWorktreeCount: number;
  linkedTaskCount: number;
  latestAgentId?: string;
}

export interface AcceptSubagentOptions {
  discardWorktree?: boolean;
  allowDirtyTarget?: boolean;
}

export class AgentManager {
  private readonly runner: SubagentRunner;
  private readonly worktreeManager: WorktreeManager;

  constructor(private readonly options: AgentManagerOptions) {
    this.runner = options.runner ?? defaultSubagentRunner;
    this.worktreeManager = options.worktreeManager ?? new WorktreeManager({ repositoryRoot: options.projectRoot });
  }

  runReadonly(input: string | { prompt: string; agentType?: Exclude<AgentType, "coding"> }): Promise<AgentRunRecord> {
    const prompt = typeof input === "string" ? input : input.prompt;
    const agentType = typeof input === "string" ? "investigator" : input.agentType ?? "investigator";
    return this.run({ prompt, agentType, cwd: this.options.projectRoot, readonly: true });
  }

  async runCoding(prompt: string, options: { worktree?: string; taskId?: string } = {}): Promise<AgentRunRecord> {
    const id = await this.nextAgentId();
    const worktreeName = options.worktree ?? slug(`${id}-${prompt}`);
    const worktree = await this.worktreeManager.create({ name: worktreeName });
    return this.run({
      id,
      prompt,
      agentType: "coding",
      cwd: worktree.path,
      readonly: false,
      worktree: worktree.name,
      worktreePath: worktree.path,
      taskId: options.taskId
    });
  }

  async list(): Promise<AgentRunRecord[]> {
    try {
      const data = JSON.parse(await readFile(this.indexPath(), "utf8")) as { agents?: AgentRunRecord[] };
      return Promise.all((data.agents ?? []).map((agent) => this.enrichAgent(this.normalizeAgentRecord(agent))));
    } catch {
      return [];
    }
  }

  async get(id: string): Promise<AgentRunRecord | undefined> {
    const agentId = requiredText(id, "agent id");
    return (await this.list()).find((agent) => agent.id === agentId);
  }

  async metadata(): Promise<AgentManagerMetadata> {
    const agents = await this.list();
    return {
      projectRoot: this.options.projectRoot,
      runCount: agents.length,
      readonlyCount: agents.filter((agent) => agent.readonly).length,
      codingCount: agents.filter((agent) => agent.agentType === "coding").length,
      completedCount: agents.filter((agent) => agent.status === "completed").length,
      acceptedCount: agents.filter((agent) => agent.status === "accepted").length,
      discardedCount: agents.filter((agent) => agent.status === "discarded").length,
      dirtyWorktreeCount: agents.filter((agent) => agent.worktreeDirty).length,
      linkedTaskCount: agents.filter((agent) => Boolean(agent.taskId)).length,
      latestAgentId: agents.at(-1)?.id
    };
  }

  async discard(id: string, options: { discard?: boolean } = {}): Promise<AgentRunRecord> {
    const agentId = requiredText(id, "agent id");
    const agents = await this.list();
    const index = agents.findIndex((agent) => agent.id === agentId);
    if (index < 0) {
      throw new Error(`Subagent ${agentId} was not found.`);
    }
    const agent = agents[index];
    if (!agent?.worktree) {
      throw new Error(`Subagent ${agentId} does not have a managed worktree.`);
    }

    await this.worktreeManager.remove(agent.worktree, { discard: options.discard });
    const updated: AgentRunRecord = { ...agent, status: "discarded", worktreeDirty: false, worktreeDirtyFiles: [], updatedAt: new Date().toISOString() };
    agents[index] = updated;
    await appendJsonl(agent.eventLogPath, { type: "subagent_discarded", payload: updated });
    await this.writeIndex(agents);
    return updated;
  }

  async accept(id: string, options: AcceptSubagentOptions = {}): Promise<AgentRunRecord> {
    const agentId = requiredText(id, "agent id");
    const agents = await this.list();
    const index = agents.findIndex((agent) => agent.id === agentId);
    if (index < 0) {
      throw new Error(`Subagent ${agentId} was not found.`);
    }
    const agent = agents[index];
    if (!agent?.worktree || !agent.worktreePath) {
      throw new Error(`Subagent ${agentId} does not have a managed worktree.`);
    }

    const targetStatus = await git(this.options.projectRoot, ["status", "--short"]);
    const targetDirtyFiles = userVisibleFiles(targetStatus);
    if (targetDirtyFiles.length > 0 && !options.allowDirtyTarget) {
      throw new DirtyWorktreeError(`Target repository has uncommitted changes: ${targetDirtyFiles.join(", ")}`, targetDirtyFiles);
    }

    const changes = await collectChanges(agent.worktreePath);
    if (changes.diff.trim()) {
      const patchPath = join(this.stateDir(), agent.id, "accepted.patch");
      await mkdir(dirname(patchPath), { recursive: true });
      await writeFile(patchPath, changes.diff.endsWith("\n") ? changes.diff : `${changes.diff}\n`, "utf8");
      await git(this.options.projectRoot, ["apply", "--whitespace=nowarn", patchPath]);
    }
    if (options.discardWorktree) {
      await this.worktreeManager.remove(agent.worktree, { discard: true });
    }

    const updated: AgentRunRecord = {
      ...agent,
      status: "accepted",
      changedFiles: changes.changedFiles,
      diff: changes.diff,
      worktreeDirty: !options.discardWorktree && changes.changedFiles.length > 0,
      worktreeDirtyFiles: options.discardWorktree ? [] : changes.changedFiles,
      updatedAt: new Date().toISOString()
    };
    agents[index] = updated;
    await appendJsonl(agent.eventLogPath, { type: "subagent_accepted", payload: updated });
    await this.writeIndex(agents);
    return updated;
  }

  private async run(input: {
    id?: string;
    prompt: string;
    agentType: AgentType;
    cwd: string;
    readonly: boolean;
    worktree?: string;
    worktreePath?: string;
    taskId?: string;
  }): Promise<AgentRunRecord> {
    const prompt = requiredText(input.prompt, "prompt");
    const id = input.id ?? await this.nextAgentId();
    const now = new Date().toISOString();
    const eventLogPath = join(this.stateDir(), id, "events.jsonl");
    const request: SubagentRequest = {
      id,
      agentType: input.agentType,
      prompt,
      cwd: input.cwd,
      eventLogPath,
      transcriptPath: eventLogPath,
      readonly: input.readonly,
      worktree: input.worktree,
      taskId: input.taskId
    };
    await appendJsonl(eventLogPath, { type: "subagent_started", payload: request });
    const output = await this.runner(request);
    const changes = input.readonly ? { changedFiles: [], diff: "" } : await collectChanges(input.cwd);
    const record: AgentRunRecord = {
      id,
      agentType: input.agentType,
      prompt,
      summary: output.summary || `${input.agentType} subagent completed: ${prompt}`,
      status: "completed",
      readonly: input.readonly,
      cwd: input.cwd,
      eventLogPath,
      transcriptPath: eventLogPath,
      changedFiles: output.changedFiles ?? changes.changedFiles,
      diff: output.diff ?? changes.diff,
      validationResult: output.validationResult ?? "",
      worktreeDirty: !input.readonly && (output.changedFiles ?? changes.changedFiles).length > 0,
      worktreeDirtyFiles: input.readonly ? [] : (output.changedFiles ?? changes.changedFiles),
      taskId: input.taskId,
      worktree: input.worktree,
      worktreePath: input.worktreePath,
      createdAt: now,
      updatedAt: new Date().toISOString()
    };
    await appendJsonl(eventLogPath, { type: "subagent_completed", payload: record });
    await this.writeIndex([...(await this.list()), record]);
    return record;
  }

  private async nextAgentId(): Promise<string> {
    const ids = (await this.list()).flatMap((agent) => {
      const match = /^agent-(\d+)$/.exec(agent.id);
      return match ? [Number.parseInt(match[1] ?? "0", 10)] : [];
    });
    return `agent-${String(Math.max(0, ...ids) + 1).padStart(4, "0")}`;
  }

  private async writeIndex(agents: AgentRunRecord[]): Promise<void> {
    const path = this.indexPath();
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify({ version: 1, agents }, null, 2), "utf8");
  }

  private stateDir(): string {
    return join(this.options.projectRoot, ".tokendance", "agents");
  }

  private indexPath(): string {
    return join(this.stateDir(), "agents.json");
  }

  private normalizeAgentRecord(agent: AgentRunRecord): AgentRunRecord {
    const eventLogPath = agent.eventLogPath ?? agent.transcriptPath;
    return { ...agent, eventLogPath, transcriptPath: eventLogPath };
  }

  private async enrichAgent(agent: AgentRunRecord): Promise<AgentRunRecord> {
    if (!agent.worktree || agent.status === "discarded") {
      return { ...agent, worktreeDirty: false, worktreeDirtyFiles: [] };
    }
    try {
      const status = await this.worktreeManager.status(agent.worktree);
      return {
        ...agent,
        worktreeDirty: status.dirty,
        worktreeDirtyFiles: status.dirtyFiles
      };
    } catch {
      return {
        ...agent,
        worktreeDirty: false,
        worktreeDirtyFiles: []
      };
    }
  }
}

export function buildSubagentTools(): ToolSpec[] {
  return [createSubagentRunTool(), createSubagentListTool(), createSubagentGetTool(), createSubagentAcceptTool(), createSubagentDiscardTool()];
}

export function createSubagentRunTool(): ToolSpec<{ prompt: string; agentType: AgentType; worktree?: string; taskId?: string }, AgentRunRecord> {
  return {
    name: "subagent_run",
    description: "Run a delegated subagent. Coding subagents use managed worktrees.",
    risk: "shell",
    concurrency: "exclusive",
    parse(input) {
      if (typeof input !== "object" || input === null || typeof (input as { prompt?: unknown }).prompt !== "string") {
        throw new Error("subagent_run input requires a string prompt field");
      }
      const agentType = parseAgentType((input as { agentType?: unknown; agent_type?: unknown }).agentType ?? (input as { agent_type?: unknown }).agent_type);
      const worktree = (input as { worktree?: unknown }).worktree;
      const taskId = (input as { taskId?: unknown; task_id?: unknown }).taskId ?? (input as { task_id?: unknown }).task_id;
      if (worktree !== undefined && typeof worktree !== "string") {
        throw new Error("subagent_run worktree must be a string");
      }
      if (taskId !== undefined && typeof taskId !== "string") {
        throw new Error("subagent_run taskId must be a string");
      }
      return { prompt: (input as { prompt: string }).prompt, agentType, worktree, taskId };
    },
    execute(input, context) {
      const manager = new AgentManager({ projectRoot: context.cwd });
      if (input.agentType === "coding") {
        return manager.runCoding(input.prompt, { worktree: input.worktree, taskId: input.taskId });
      }
      return manager.runReadonly({ prompt: input.prompt, agentType: input.agentType });
    }
  };
}

export function createSubagentListTool(): ToolSpec<unknown, AgentRunRecord[]> {
  return {
    name: "subagent_list",
    description: "List delegated subagent run results.",
    risk: "read",
    concurrency: "parallel_safe",
    parse: (input) => input,
    execute: async (_input, context) => new AgentManager({ projectRoot: context.cwd }).list()
  };
}

export function createSubagentGetTool(): ToolSpec<{ id: string }, AgentRunRecord | undefined> {
  return {
    name: "subagent_get",
    description: "Get one delegated subagent run result by id.",
    risk: "read",
    concurrency: "parallel_safe",
    parse(input) {
      if (typeof input !== "object" || input === null || typeof (input as { id?: unknown }).id !== "string") {
        throw new Error("subagent_get input requires a string id field");
      }
      return { id: (input as { id: string }).id };
    },
    execute: async (input, context) => new AgentManager({ projectRoot: context.cwd }).get(input.id)
  };
}

export function createSubagentDiscardTool(): ToolSpec<{ id: string; discard?: boolean }, AgentRunRecord> {
  return {
    name: "subagent_discard",
    description: "Discard a coding subagent worktree, refusing dirty changes unless discard is true.",
    risk: "shell",
    concurrency: "exclusive",
    parse(input) {
      if (typeof input !== "object" || input === null || typeof (input as { id?: unknown }).id !== "string") {
        throw new Error("subagent_discard input requires a string id field");
      }
      const discard = (input as { discard?: unknown }).discard;
      if (discard !== undefined && typeof discard !== "boolean") {
        throw new Error("subagent_discard discard must be a boolean");
      }
      return { id: (input as { id: string }).id, discard };
    },
    execute: async (input, context) => new AgentManager({ projectRoot: context.cwd }).discard(input.id, { discard: input.discard })
  };
}

export function createSubagentAcceptTool(): ToolSpec<{ id: string; discardWorktree?: boolean; allowDirtyTarget?: boolean }, AgentRunRecord> {
  return {
    name: "subagent_accept",
    description: "Apply a coding subagent worktree diff into the target repository.",
    risk: "shell",
    concurrency: "exclusive",
    parse(input) {
      if (typeof input !== "object" || input === null || typeof (input as { id?: unknown }).id !== "string") {
        throw new Error("subagent_accept input requires a string id field");
      }
      const discardWorktree = (input as { discardWorktree?: unknown; discard_worktree?: unknown }).discardWorktree
        ?? (input as { discard_worktree?: unknown }).discard_worktree;
      const allowDirtyTarget = (input as { allowDirtyTarget?: unknown; allow_dirty_target?: unknown }).allowDirtyTarget
        ?? (input as { allow_dirty_target?: unknown }).allow_dirty_target;
      if (discardWorktree !== undefined && typeof discardWorktree !== "boolean") {
        throw new Error("subagent_accept discardWorktree must be a boolean");
      }
      if (allowDirtyTarget !== undefined && typeof allowDirtyTarget !== "boolean") {
        throw new Error("subagent_accept allowDirtyTarget must be a boolean");
      }
      return {
        id: (input as { id: string }).id,
        discardWorktree,
        allowDirtyTarget
      };
    },
    execute: async (input, context) => new AgentManager({ projectRoot: context.cwd }).accept(input.id, {
      discardWorktree: input.discardWorktree,
      allowDirtyTarget: input.allowDirtyTarget
    })
  };
}

async function defaultSubagentRunner(request: SubagentRequest): Promise<SubagentOutput> {
  if (request.readonly) {
    return { summary: `${request.agentType} subagent completed: ${request.prompt}` };
  }
  return { summary: `coding subagent prepared worktree ${request.worktree}: ${request.prompt}`, validationResult: "not run" };
}

async function appendJsonl(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const existing = await readOptional(path);
  await writeFile(path, `${existing}${JSON.stringify(value)}\n`, "utf8");
}

async function collectChanges(cwd: string): Promise<{ changedFiles: string[]; diff: string }> {
  const status = await git(cwd, ["status", "--short"]);
  const changedFiles = parseStatusFiles(status);
  const diff = await git(cwd, ["diff"]);
  const untrackedDiffs = await Promise.all(
    changedFiles
      .filter((file) => status.split(/\r?\n/).some((line) => line.startsWith("?? ") && line.slice(3).trim() === file))
      .map((file) => untrackedDiff(cwd, file))
  );
  return { changedFiles, diff: [diff, ...untrackedDiffs].filter((part) => part.trim()).join("\n") };
}

function parseStatusFiles(status: string): string[] {
  return parseGitStatusFiles(status);
}

function userVisibleFiles(status: string): string[] {
  return parseStatusFiles(status).filter((path) => !path.startsWith(".tokendance/") && !path.startsWith(".worktrees/"));
}

async function untrackedDiff(cwd: string, file: string): Promise<string> {
  const content = await readFile(join(cwd, file), "utf8");
  const lines = content.split(/\r?\n/).filter((line, index, all) => index < all.length - 1 || line.length > 0);
  return [
    `diff --git a/${file} b/${file}`,
    "new file mode 100644",
    "--- /dev/null",
    `+++ b/${file}`,
    `@@ -0,0 +1,${lines.length} @@`,
    ...lines.map((line) => `+${line}`)
  ].join("\n");
}

async function git(cwd: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", args, { cwd, windowsHide: true });
    return String(stdout);
  } catch (error) {
    const candidate = error as { stdout?: unknown; stderr?: unknown; message?: unknown };
    throw new Error(String(candidate.stderr || candidate.stdout || candidate.message || "git command failed").trim());
  }
}

async function readOptional(path: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return "";
  }
}

function requiredText(value: string, label: string): string {
  const text = value.trim();
  if (!text) {
    throw new Error(`${label} is required.`);
  }
  return text;
}

function parseAgentType(value: unknown): AgentType {
  if (value === undefined) {
    return "investigator";
  }
  if (value === "investigator" || value === "reviewer" || value === "coding") {
    return value;
  }
  throw new Error(`Unknown subagent type: ${String(value)}`);
}

function slug(value: string): string {
  return (value.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^[-._]+|[-._]+$/g, "") || "subagent").slice(0, 48);
}
