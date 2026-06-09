import {
  AgentRuntime,
  AgentManager,
  AnthropicMessagesProvider,
  CompactService,
  ContextBuilder,
  FileTranscriptStore,
  MemoryStore,
  MockProvider,
  OpenAIChatCompletionsProvider,
  OpenAIResponsesProvider,
  ResumeService,
  TaskStore,
  TodoStore,
  WorktreeManager,
  ToolOrchestrator,
  createDefaultToolRegistry,
  readTokenDanceConfig,
  readTranscript,
  type AgentRunRecord,
  type AgentType,
  type ModelProvider,
  type PermissionApprovalCallback,
  type PermissionMode,
  type SessionState,
  type TDCodeEvent,
  type TDCodeEventSink,
  type CompactResult,
  type ConfigInfo,
  type BuiltContext,
  type TaskRecord,
  type TaskStatus,
  type TodoRecord,
  type TodoStatus,
  type TranscriptEnvelope,
  type ToolResult,
  type ToolMetadata,
  type WorktreeRecord
} from "@tokendance/code-core";
import { join } from "node:path";
import { collectDoctorInfo } from "./doctor.js";

export * from "./agenthub-events.js";
export * from "./approval-bridge.js";
export * from "./doctor.js";
export * from "./package-info.js";

export type ThreadInput = string | Array<{ type: "text"; text: string }>;

export type TokenDanceProviderConfig =
  | { type: "mock" }
  | { type: "openai-responses"; apiKey?: string; model: string; baseUrl?: string }
  | { type: "openai-chat-completions"; apiKey?: string; model: string; baseUrl?: string }
  | { type: "anthropic-messages"; apiKey?: string; model: string; baseUrl?: string; maxTokens?: number; anthropicVersion?: string };

export interface TokenDanceCodeOptions {
  provider?: ModelProvider | TokenDanceProviderConfig;
  storageRoot?: string;
  env?: Record<string, string | undefined>;
  approvalCallback?: PermissionApprovalCallback;
  eventSink?: TDCodeEventSink;
}

export interface StartThreadOptions {
  id?: string;
  workingDirectory?: string;
  permissionMode?: PermissionMode;
}

export interface ResumeThreadOptions {
  sessionId?: string;
  storageRoot?: string;
}

export interface TurnResult {
  threadId: string;
  finalResponse: string;
  events: TDCodeEvent[];
}

export interface TranscriptInfo {
  sessionId: string;
  sessionDir: string;
  transcriptPath: string;
  eventCount: number;
  recentEventCount: number;
}

export interface TranscriptSearchResult {
  sessionId: string;
  seq: number;
  eventType: TDCodeEvent["type"];
  timestamp: string;
  turnId?: string;
  preview: string;
}

export type ThreadContext = BuiltContext;

export interface ThreadContextOptions {
  maxRecentMessages?: number;
}

export type MemoryScope = "project" | "global";

export interface MemoryOptions {
  projectRoot?: string;
  homeDir?: string;
}

export interface ToolFacadeOptions {
  workingDirectory?: string;
  permissionMode?: PermissionMode;
}

export interface ToolExecuteOptions {
  permissionMode?: PermissionMode;
}

export interface ConfigOptions {
  projectRoot?: string;
  homeDir?: string;
}

export interface DoctorFacadeOptions {
  projectRoot?: string;
  homeDir?: string;
}

export interface TaskOptions {
  projectRoot?: string;
}

export interface TodoOptions {
  projectRoot?: string;
  sessionId?: string;
}

export interface WorktreeOptions {
  repositoryRoot?: string;
  worktreeRoot?: string;
}

export interface SubagentOptions {
  projectRoot?: string;
}

export class TokenDanceCode {
  constructor(private readonly options: TokenDanceCodeOptions = {}) {}

  startThread(options: StartThreadOptions = {}): Thread {
    const now = new Date().toISOString();
    return new Thread({
      client: this,
      session: {
        id: options.id ?? crypto.randomUUID(),
        cwd: options.workingDirectory ?? process.cwd(),
        createdAt: now,
        updatedAt: now,
        permissionMode: options.permissionMode ?? "default",
        messages: []
      }
    });
  }

  resumeThread(session: SessionState): Thread {
    return new Thread({ client: this, session });
  }

  resume(options: ResumeThreadOptions = {}): Promise<Thread> {
    if (options.sessionId) {
      return this.loadThread(options.sessionId, options.storageRoot);
    }
    return this.loadLatestThread(options.storageRoot);
  }

  async loadThread(sessionId: string, storageRoot = process.cwd()): Promise<Thread> {
    const result = await new ResumeService(storageRoot).byId(sessionId);
    return new Thread({ client: this, session: result.session, recentTranscript: result.recent });
  }

  async loadLatestThread(storageRoot = process.cwd()): Promise<Thread> {
    const result = await new ResumeService(storageRoot).latest();
    return new Thread({ client: this, session: result.session, recentTranscript: result.recent });
  }

  compactSession(session: SessionState): Promise<CompactResult> {
    return new CompactService(new FileTranscriptStore({ rootDir: this.storageRootFor(session) }).sessionDir(session.id)).manualCompact();
  }

  async compact(options: ResumeThreadOptions = {}): Promise<CompactResult> {
    const thread = await this.resume(options);
    return thread.compact();
  }

  memory(options: MemoryOptions = {}): TokenDanceMemory {
    return new TokenDanceMemory(
      new MemoryStore({
        projectRoot: options.projectRoot ?? this.options.storageRoot ?? process.cwd(),
        homeDir: options.homeDir
      })
    );
  }

  tools(options: ToolFacadeOptions = {}): TokenDanceTools {
    const now = new Date().toISOString();
    return new TokenDanceTools({
      cwd: options.workingDirectory ?? this.options.storageRoot ?? process.cwd(),
      permissionMode: options.permissionMode ?? "default",
      now
    });
  }

  config(options: ConfigOptions = {}): Promise<ConfigInfo> {
    return readTokenDanceConfig({
      projectRoot: options.projectRoot ?? this.options.storageRoot ?? process.cwd(),
      homeDir: options.homeDir,
      env: this.options.env
    });
  }

  doctor(options: DoctorFacadeOptions = {}) {
    return collectDoctorInfo({
      projectRoot: options.projectRoot ?? this.options.storageRoot ?? process.cwd(),
      homeDir: options.homeDir,
      env: this.options.env
    });
  }

  tasks(options: TaskOptions = {}): TokenDanceTasks {
    return new TokenDanceTasks(new TaskStore({ projectRoot: options.projectRoot ?? this.options.storageRoot ?? process.cwd() }));
  }

  todos(options: TodoOptions = {}): TokenDanceTodos {
    return new TokenDanceTodos(
      new TodoStore({
        projectRoot: options.projectRoot ?? this.options.storageRoot ?? process.cwd(),
        sessionId: options.sessionId
      })
    );
  }

  worktrees(options: WorktreeOptions = {}): TokenDanceWorktrees {
    return new TokenDanceWorktrees(
      new WorktreeManager({
        repositoryRoot: options.repositoryRoot ?? this.options.storageRoot ?? process.cwd(),
        worktreeRoot: options.worktreeRoot
      })
    );
  }

  subagents(options: SubagentOptions = {}): TokenDanceSubagents {
    return new TokenDanceSubagents(new AgentManager({ projectRoot: options.projectRoot ?? this.options.storageRoot ?? process.cwd() }));
  }

  async transcriptInfo(session: SessionState, recentEventCount = 0): Promise<TranscriptInfo> {
    const sessionDir = new FileTranscriptStore({ rootDir: this.storageRootFor(session) }).sessionDir(session.id);
    const transcriptPath = join(sessionDir, "transcript.jsonl");
    const envelopes = await readTranscript(transcriptPath);
    return {
      sessionId: session.id,
      sessionDir,
      transcriptPath,
      eventCount: envelopes.length,
      recentEventCount
    };
  }

  async searchTranscript(session: SessionState, query: string, limit = 20): Promise<TranscriptSearchResult[]> {
    const normalizedQuery = query.trim().toLowerCase();
    if (!normalizedQuery || limit <= 0) {
      return [];
    }

    const info = await this.transcriptInfo(session);
    const envelopes = await readTranscript(info.transcriptPath);
    return envelopes
      .filter((envelope) => isSearchableTranscriptEvent(envelope.event))
      .map((envelope) => ({ envelope, serialized: JSON.stringify(envelope.event) }))
      .filter(({ serialized }) => serialized.toLowerCase().includes(normalizedQuery))
      .slice(0, limit)
      .map(({ envelope, serialized }) => ({
        sessionId: envelope.sessionId,
        seq: envelope.seq,
        eventType: envelope.event.type,
        timestamp: envelope.timestamp,
        turnId: envelope.turnId,
        preview: previewMatch(serialized, normalizedQuery)
      }));
  }

  createRuntime(session: SessionState): AgentRuntime {
    return new AgentRuntime({
      provider: this.resolveProvider(),
      store: new FileTranscriptStore({ rootDir: this.storageRootFor(session) }),
      session,
      approvalCallback: this.options.approvalCallback,
      eventSink: this.options.eventSink
    });
  }

  private storageRootFor(session: SessionState): string {
    return this.options.storageRoot ?? session.cwd;
  }

  private resolveProvider(): ModelProvider {
    const provider = this.options.provider;
    if (!provider) {
      return new MockProvider();
    }
    if ("createTurn" in provider) {
      return provider;
    }

    const env = this.options.env ?? process.env;
    if (provider.type === "mock") {
      return new MockProvider();
    }
    if (provider.type === "openai-responses") {
      return new OpenAIResponsesProvider({
        apiKey: provider.apiKey ?? env.OPENAI_API_KEY ?? "",
        model: provider.model,
        baseUrl: provider.baseUrl
      });
    }
    if (provider.type === "openai-chat-completions") {
      return new OpenAIChatCompletionsProvider({
        apiKey: provider.apiKey ?? env.OPENAI_API_KEY ?? "",
        model: provider.model,
        baseUrl: provider.baseUrl
      });
    }
    return new AnthropicMessagesProvider({
      apiKey: provider.apiKey ?? env.ANTHROPIC_API_KEY ?? "",
      model: provider.model,
      baseUrl: provider.baseUrl,
      maxTokens: provider.maxTokens,
      anthropicVersion: provider.anthropicVersion
    });
  }
}

export class Thread {
  readonly id: string;
  readonly recentTranscript: TranscriptEnvelope[];

  constructor(private readonly options: { client: TokenDanceCode; session: SessionState; recentTranscript?: TranscriptEnvelope[] }) {
    this.id = options.session.id;
    this.recentTranscript = options.recentTranscript ?? [];
  }

  get state(): SessionState {
    return cloneSession(this.options.session);
  }

  async run(input: ThreadInput): Promise<TurnResult> {
    const events: TDCodeEvent[] = [];
    let finalResponse = "";
    const streamed = await this.runStreamed(input);

    for await (const event of streamed.events) {
      events.push(event);
      if (event.type === "turn.completed") {
        finalResponse = event.finalResponse;
      }
    }

    return { threadId: this.id, finalResponse, events };
  }

  async runStreamed(input: ThreadInput): Promise<{ events: AsyncGenerator<TDCodeEvent> }> {
    const runtime = this.options.client.createRuntime(this.options.session);
    await runtime.initialize();
    const source = runtime.runTurn(normalizeInput(input));
    const self = this;

    async function* events(): AsyncGenerator<TDCodeEvent> {
      try {
        yield* source;
      } finally {
        self.options.session = runtime.state;
      }
    }

    return { events: events() };
  }

  compact(): Promise<CompactResult> {
    return this.options.client.compactSession(this.options.session);
  }

  transcript(): Promise<TranscriptInfo> {
    return this.options.client.transcriptInfo(this.options.session, this.recentTranscript.length);
  }

  searchTranscript(query: string, options: { limit?: number } = {}): Promise<TranscriptSearchResult[]> {
    return this.options.client.searchTranscript(this.options.session, query, options.limit);
  }

  context(input: ThreadInput, options: ThreadContextOptions = {}): Promise<ThreadContext> {
    return new ContextBuilder({ maxRecentMessages: options.maxRecentMessages }).build({
      session: this.options.session,
      userMessage: normalizeInput(input),
      workspaceRoot: this.options.session.cwd
    });
  }
}

export class TokenDanceMemory {
  constructor(private readonly store: MemoryStore) {}

  add(scope: MemoryScope, text: string): Promise<void> {
    return scope === "project" ? this.store.addProjectMemory(text) : this.store.addGlobalMemory(text);
  }

  list(scope: MemoryScope): Promise<string[]> {
    return scope === "project" ? this.store.listProjectMemory() : this.store.listGlobalMemory();
  }

  delete(scope: MemoryScope, index: number): Promise<void> {
    return scope === "project" ? this.store.deleteProjectMemory(index) : this.store.deleteGlobalMemory(index);
  }
}

export class TokenDanceTools {
  constructor(private readonly options: { cwd: string; permissionMode: PermissionMode; now: string }) {}

  list(): ToolMetadata[] {
    return createDefaultToolRegistry().metadata();
  }

  execute(name: string, input: unknown = {}, options: ToolExecuteOptions = {}): Promise<ToolResult> {
    const session: SessionState = {
      id: crypto.randomUUID(),
      cwd: this.options.cwd,
      createdAt: this.options.now,
      updatedAt: new Date().toISOString(),
      permissionMode: options.permissionMode ?? this.options.permissionMode,
      messages: []
    };
    return new ToolOrchestrator(createDefaultToolRegistry()).execute(
      {
        id: crypto.randomUUID(),
        name,
        input
      },
      session
    );
  }
}

export class TokenDanceTasks {
  constructor(private readonly store: TaskStore) {}

  create(input: { title: string; description?: string }): Promise<TaskRecord> {
    return this.store.create(input);
  }

  list(): Promise<TaskRecord[]> {
    return this.store.list();
  }

  get(id: string): Promise<TaskRecord | undefined> {
    return this.store.get(id);
  }

  updateStatus(id: string, status: TaskStatus): Promise<TaskRecord> {
    return this.store.updateStatus(id, status);
  }

  addDependency(id: string, dependencyId: string): Promise<TaskRecord> {
    return this.store.addDependency(id, dependencyId);
  }

  linkSession(id: string, sessionId: string): Promise<TaskRecord> {
    return this.store.linkSession(id, sessionId);
  }

  linkWorktree(id: string, worktree: string): Promise<TaskRecord> {
    return this.store.linkWorktree(id, worktree);
  }
}

export class TokenDanceTodos {
  constructor(private readonly store: TodoStore) {}

  add(input: { text: string; taskId?: string }): Promise<TodoRecord> {
    return this.store.add(input);
  }

  list(): Promise<TodoRecord[]> {
    return this.store.list();
  }

  updateStatus(id: string, status: TodoStatus): Promise<TodoRecord> {
    return this.store.updateStatus(id, status);
  }
}

export class TokenDanceWorktrees {
  constructor(private readonly manager: WorktreeManager) {}

  list(): Promise<WorktreeRecord[]> {
    return this.manager.list();
  }

  create(input: { name: string; branch?: string }): Promise<WorktreeRecord> {
    return this.manager.create(input);
  }

  remove(name: string, options: { discard?: boolean } = {}): Promise<void> {
    return this.manager.remove(name, options);
  }
}

export class TokenDanceSubagents {
  constructor(private readonly manager: AgentManager) {}

  list(): Promise<AgentRunRecord[]> {
    return this.manager.list();
  }

  get(id: string): Promise<AgentRunRecord | undefined> {
    return this.manager.get(id);
  }

  runReadonly(input: { prompt: string; agentType?: Exclude<AgentType, "coding"> }): Promise<AgentRunRecord> {
    return this.manager.runReadonly(input);
  }

  runCoding(input: { prompt: string; worktree?: string; taskId?: string }): Promise<AgentRunRecord> {
    return this.manager.runCoding(input.prompt, { worktree: input.worktree, taskId: input.taskId });
  }

  accept(id: string, options: { discardWorktree?: boolean; allowDirtyTarget?: boolean } = {}): Promise<AgentRunRecord> {
    return this.manager.accept(id, options);
  }

  discard(id: string, options: { discard?: boolean } = {}): Promise<AgentRunRecord> {
    return this.manager.discard(id, options);
  }
}

function isSearchableTranscriptEvent(event: TDCodeEvent): boolean {
  return event.type !== "assistant.completed" && event.type !== "turn.completed";
}

function previewMatch(serialized: string, normalizedQuery: string): string {
  const index = serialized.toLowerCase().indexOf(normalizedQuery);
  if (index < 0) {
    return serialized.slice(0, 120);
  }
  const start = Math.max(0, index - 40);
  const end = Math.min(serialized.length, index + normalizedQuery.length + 80);
  const prefix = start > 0 ? "..." : "";
  const suffix = end < serialized.length ? "..." : "";
  return `${prefix}${serialized.slice(start, end)}${suffix}`;
}

function normalizeInput(input: ThreadInput): string {
  if (typeof input === "string") {
    return input;
  }
  return input
    .filter((item) => item.type === "text")
    .map((item) => item.text)
    .join("\n");
}

function cloneSession(session: SessionState): SessionState {
  return {
    ...session,
    messages: session.messages.map((message) => ({ ...message }))
  };
}

export type { AgentRunRecord, CompactResult, ModelProvider, PermissionApprovalCallback, PermissionMode, SessionState, TDCodeEvent, TDCodeEventSink, TranscriptEnvelope };
