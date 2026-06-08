import type { Writable } from "node:stream";
import type { TDCodeEvent } from "@tokendance/code-sdk";

const maxToolSummaryLength = 120;

export interface EventRendererIO {
  stdout: Writable;
}

export interface EventRenderer {
  render(event: TDCodeEvent): Promise<void>;
}

interface RendererState {
  toolStarts: Map<string, number>;
  assistantTextOpen: boolean;
  renderedAssistantText: boolean;
}

export function createEventRenderer(io: EventRendererIO): EventRenderer {
  const state: RendererState = {
    toolStarts: new Map(),
    assistantTextOpen: false,
    renderedAssistantText: false
  };

  return {
    render(event) {
      return renderEvent(io, event, state);
    }
  };
}

async function renderEvent(io: EventRendererIO, event: TDCodeEvent, state: RendererState): Promise<void> {
  switch (event.type) {
    case "assistant.delta":
      state.renderedAssistantText = true;
      state.assistantTextOpen = true;
      await write(io.stdout, event.text);
      return;
    case "assistant.completed":
      await flushAssistantLine(io, state);
      return;
    case "tool.started":
      await flushAssistantLine(io, state);
      state.toolStarts.set(event.call.id, Date.now());
      await write(io.stdout, `tool ${event.call.name} started\n`);
      return;
    case "tool.permission":
      await flushAssistantLine(io, state);
      await write(io.stdout, `permission ${event.decision.status}: ${event.decision.reason}\n`);
      return;
    case "tool.completed":
      await flushAssistantLine(io, state);
      const duration = renderToolDuration(state, event.result.callId);
      if (event.result.ok) {
        const summary = summarizeToolOutput(event.result.output);
        await write(io.stdout, `tool ${event.result.toolName} completed${summary ? `: ${summary}` : ""}${duration}\n`);
        return;
      }
      await write(io.stdout, `tool ${event.result.toolName} failed: ${event.result.error ?? "unknown error"}${duration}\n`);
      return;
    case "turn.completed":
      await flushAssistantLine(io, state);
      if (!state.renderedAssistantText && event.finalResponse) {
        await write(io.stdout, `${event.finalResponse}\n`);
      }
      if (event.usage) {
        await write(io.stdout, `usage input=${event.usage.inputTokens} output=${event.usage.outputTokens}\n`);
      }
      return;
    default:
      return;
  }
}

async function flushAssistantLine(io: EventRendererIO, state: RendererState): Promise<void> {
  if (!state.assistantTextOpen) {
    return;
  }
  state.assistantTextOpen = false;
  await write(io.stdout, "\n");
}

function renderToolDuration(state: RendererState, callId: string): string {
  const startedAt = state.toolStarts.get(callId);
  state.toolStarts.delete(callId);
  return startedAt === undefined ? "" : ` duration=${Math.max(0, Date.now() - startedAt)}ms`;
}

function summarizeToolOutput(output: unknown): string {
  if (output === undefined) {
    return "";
  }

  const serialized = serializeToolOutput(output);
  if (serialized.length <= maxToolSummaryLength) {
    return serialized;
  }

  const omitted = serialized.length - maxToolSummaryLength;
  return `${serialized.slice(0, maxToolSummaryLength)}... omitted ${omitted} chars`;
}

function serializeToolOutput(output: unknown): string {
  if (typeof output === "string") {
    return output;
  }
  try {
    return JSON.stringify(output);
  } catch {
    return String(output);
  }
}

function write(stream: Writable, text: string): Promise<void> {
  return new Promise((resolveWrite, reject) => {
    stream.write(text, (error) => {
      if (error) {
        reject(error);
        return;
      }
      resolveWrite();
    });
  });
}
