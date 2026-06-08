import {
  AgentRuntime,
  FileTranscriptStore,
  MockProvider,
  ResumeService,
  type ModelProvider,
  type PermissionMode,
  type SessionState,
  type TDCodeEvent,
  type TranscriptEnvelope
} from "@tokendance/code-core";

export type ThreadInput = string | Array<{ type: "text"; text: string }>;

export interface TokenDanceCodeOptions {
  provider?: ModelProvider;
  storageRoot?: string;
}

export interface StartThreadOptions {
  id?: string;
  workingDirectory?: string;
  permissionMode?: PermissionMode;
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

  async loadThread(sessionId: string, storageRoot = process.cwd()): Promise<Thread> {
    const result = await new ResumeService(storageRoot).byId(sessionId);
    return new Thread({ client: this, session: result.session, recentTranscript: result.recent });
  }

  async loadLatestThread(storageRoot = process.cwd()): Promise<Thread> {
    const result = await new ResumeService(storageRoot).latest();
    return new Thread({ client: this, session: result.session, recentTranscript: result.recent });
  }

  createRuntime(session: SessionState): AgentRuntime {
    return new AgentRuntime({
      provider: this.options.provider ?? new MockProvider(),
      store: new FileTranscriptStore({ rootDir: this.options.storageRoot ?? session.cwd }),
      session
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

export type { ModelProvider, PermissionMode, SessionState, TDCodeEvent, TranscriptEnvelope };
