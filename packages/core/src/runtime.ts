import { randomUUID } from "node:crypto";
import { ContextBuilder } from "./context-builder.js";
import { normalizeApprovalDecision, PermissionEngine } from "./permissions.js";
import { appendMessage, createSession } from "./session.js";
import { createDefaultToolRegistry, ToolOrchestrator, ToolRegistry } from "./tools.js";
import type {
  ModelProvider,
  PermissionApprovalCallback,
  PermissionDecision,
  SessionState,
  TDCodeEvent,
  TDCodeEventSink,
  TDMessage,
  ToolCall,
  ToolResult,
  ToolSpec,
  TranscriptStore
} from "./types.js";

export interface AgentRuntimeOptions {
  provider: ModelProvider;
  store?: TranscriptStore;
  registry?: ToolRegistry;
  session?: SessionState;
  cwd?: string;
  approvalCallback?: PermissionApprovalCallback;
  eventSink?: TDCodeEventSink;
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
    const context = await new ContextBuilder().build({ session: this.session, userMessage: input });
    this.session = appendMessage(this.session, userMessage);
    await this.persistSession();
    yield* this.emit({ type: "user.message", sessionId: this.session.id, turnId, message: userMessage });

    try {
      yield* this.runProviderLoop(turnId, context.messages);
    } catch (error) {
      yield* this.emit({ type: "turn.failed", sessionId: this.session.id, turnId, error: errorMessage(error) });
      throw error;
    }
  }

  private async *runProviderLoop(turnId: string, contextMessages: TDMessage[]): AsyncGenerator<TDCodeEvent> {
    const orchestrator = new ToolOrchestrator(this.registry);
    const toolResults: ToolResult[] = [];
    const providerSession: SessionState = { ...this.session, messages: contextMessages };
    for (let step = 0; step < 8; step += 1) {
      const response = await this.options.provider.createTurn({
        session: providerSession,
        tools: this.registry.list(),
        toolResults
      });

      if (response.assistantMessage) {
        yield* this.emit({ type: "assistant.delta", sessionId: this.session.id, turnId, text: response.assistantMessage });
        const assistantMessage: TDMessage = { role: "assistant", content: response.assistantMessage };
        this.session = appendMessage(this.session, assistantMessage);
        await this.persistSession();
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
        let decision: PermissionDecision | undefined;
        if (tool) {
          decision = await this.decideTool(call, tool, turnId);
          yield* this.emit({ type: "tool.permission", sessionId: this.session.id, turnId, call, decision });
        }
        const result = await orchestrator.execute(call, this.session, decision);
        toolResults.push(result);
        yield* this.emit({ type: "tool.completed", sessionId: this.session.id, turnId, result });
      }
    }

    throw new Error("Tool loop exceeded 8 steps");
  }

  private async decideTool(call: ToolCall, tool: ToolSpec, turnId: string): Promise<PermissionDecision> {
    const baseDecision = new PermissionEngine(this.session.permissionMode).decide(tool);
    if (baseDecision.status !== "requires_approval" || !this.options.approvalCallback) {
      return baseDecision;
    }

    const response = await this.options.approvalCallback({
      session: this.session,
      turnId,
      call,
      tool,
      decision: baseDecision
    });

    return normalizeApprovalDecision(baseDecision, response);
  }

  private async *emit(event: TDCodeEvent): AsyncGenerator<TDCodeEvent> {
    await this.options.store?.append(event);
    await this.options.eventSink?.(event);
    yield event;
  }

  private persistSession(): Promise<void> {
    return this.options.store?.saveSession?.(this.session) ?? Promise.resolve();
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
