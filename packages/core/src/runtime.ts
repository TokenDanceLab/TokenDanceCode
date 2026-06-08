import { randomUUID } from "node:crypto";
import { PermissionEngine } from "./permissions.js";
import { appendMessage, createSession } from "./session.js";
import { createDefaultToolRegistry, ToolOrchestrator, ToolRegistry } from "./tools.js";
import type { ModelProvider, SessionState, TDCodeEvent, TDMessage, ToolResult, TranscriptStore } from "./types.js";

export interface AgentRuntimeOptions {
  provider: ModelProvider;
  store?: TranscriptStore;
  registry?: ToolRegistry;
  session?: SessionState;
  cwd?: string;
}

export class AgentRuntime {
  readonly registry: ToolRegistry;
  private session: SessionState;

  constructor(private readonly options: AgentRuntimeOptions) {
    this.session = options.session ?? createSession({ cwd: options.cwd ?? process.cwd() });
    this.registry = options.registry ?? createDefaultToolRegistry();
  }

  get state(): SessionState {
    return this.session;
  }

  async initialize(): Promise<void> {
    await this.options.store?.initialize(this.session);
  }

  async *runTurn(input: string): AsyncGenerator<TDCodeEvent> {
    const turnId = randomUUID();
    const userMessage: TDMessage = { role: "user", content: input };
    this.session = appendMessage(this.session, userMessage);
    yield* this.emit({ type: "user.message", sessionId: this.session.id, turnId, message: userMessage });

    const orchestrator = new ToolOrchestrator(this.registry);
    const toolResults: ToolResult[] = [];

    for (let step = 0; step < 8; step += 1) {
      const response = await this.options.provider.createTurn({
        session: this.session,
        tools: this.registry.list(),
        toolResults
      });

      if (response.assistantMessage) {
        yield* this.emit({ type: "assistant.delta", sessionId: this.session.id, turnId, text: response.assistantMessage });
        const assistantMessage: TDMessage = { role: "assistant", content: response.assistantMessage };
        this.session = appendMessage(this.session, assistantMessage);
        yield* this.emit({ type: "assistant.completed", sessionId: this.session.id, turnId, message: assistantMessage });
        yield* this.emit({
          type: "turn.completed",
          sessionId: this.session.id,
          turnId,
          finalResponse: response.assistantMessage,
          usage: response.usage
        });
        return;
      }

      if (response.toolCalls.length === 0) {
        yield* this.emit({ type: "turn.completed", sessionId: this.session.id, turnId, finalResponse: "" });
        return;
      }

      for (const call of response.toolCalls) {
        yield* this.emit({ type: "tool.started", sessionId: this.session.id, turnId, call });
        const tool = this.registry.get(call.name);
        if (tool) {
          const decision = new PermissionEngine(this.session.permissionMode).decide(tool);
          yield* this.emit({ type: "tool.permission", sessionId: this.session.id, turnId, call, decision });
        }
        const result = await orchestrator.execute(call, this.session);
        toolResults.push(result);
        yield* this.emit({ type: "tool.completed", sessionId: this.session.id, turnId, result });
      }
    }

    throw new Error("Tool loop exceeded 8 steps");
  }

  private async *emit(event: TDCodeEvent): AsyncGenerator<TDCodeEvent> {
    await this.options.store?.append(event);
    yield event;
  }
}
