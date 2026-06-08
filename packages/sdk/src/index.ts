import {
  AgentRuntime,
  FileTranscriptStore,
  MockProvider,
  type ModelProvider,
  type PermissionMode,
  type SessionState,
  type TDCodeEvent
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
    const store = new FileTranscriptStore({ rootDir: storageRoot });
    return this.resumeThread(await store.loadSession(sessionId));
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

  constructor(private readonly options: { client: TokenDanceCode; session: SessionState }) {
    this.id = options.session.id;
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

export type { ModelProvider, PermissionMode, SessionState, TDCodeEvent };
