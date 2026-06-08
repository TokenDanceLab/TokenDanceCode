import {
  AgentRuntime,
  AnthropicMessagesProvider,
  CompactService,
  FileTranscriptStore,
  MockProvider,
  OpenAIResponsesProvider,
  ResumeService,
  type ModelProvider,
  type PermissionApprovalCallback,
  type PermissionMode,
  type SessionState,
  type TDCodeEvent,
  type TDCodeEventSink,
  type CompactResult,
  type TranscriptEnvelope
} from "@tokendance/code-core";

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
