import {
  AgentRuntime,
  AnthropicMessagesProvider,
  CompactService,
  FileTranscriptStore,
  MemoryStore,
  MockProvider,
  OpenAIResponsesProvider,
  ResumeService,
  ToolOrchestrator,
  createDefaultToolRegistry,
  readTranscript,
  type ModelProvider,
  type PermissionApprovalCallback,
  type PermissionMode,
  type SessionState,
  type TDCodeEvent,
  type TDCodeEventSink,
  type CompactResult,
  type TranscriptEnvelope,
  type ToolResult
} from "@tokendance/code-core";
import { join } from "node:path";

export * from "./agenthub-events.js";
export * from "./approval-bridge.js";

export type ThreadInput = string | Array<{ type: "text"; text: string }>;

export type TokenDanceProviderConfig =
  | { type: "mock" }
  | { type: "openai-responses"; apiKey?: string; model: string; baseUrl?: string }
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

export type { CompactResult, ModelProvider, PermissionApprovalCallback, PermissionMode, SessionState, TDCodeEvent, TDCodeEventSink, TranscriptEnvelope };
