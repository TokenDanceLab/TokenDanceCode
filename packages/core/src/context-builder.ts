import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { MemoryStore } from "./memory.js";
import type { SessionState, TDMessage } from "./types.js";

const defaultSystemPrompt = "TokenDanceCode is a local command-line coding agent. Keep responses concise, concrete, and action-oriented.";

export interface ContextBuilderOptions {
  maxRecentMessages?: number;
  systemPrompt?: string;
}

export interface BuildContextInput {
  session: SessionState;
  userMessage: string;
  workspaceRoot?: string;
}

export interface BuiltContext {
  messages: TDMessage[];
  includedFiles: string[];
}

export class ContextBuilder {
  constructor(private readonly options: ContextBuilderOptions = {}) {}

  async build(input: BuildContextInput): Promise<BuiltContext> {
    const includedFiles: string[] = [];
    const systemParts = [this.options.systemPrompt ?? defaultSystemPrompt];
    const workspaceRoot = input.workspaceRoot ?? input.session.cwd;

    for (const filename of ["AGENTS.md", "README.md"]) {
      const content = await readOptionalText(join(workspaceRoot, filename));
      if (content) {
        includedFiles.push(filename);
        systemParts.push(`## ${filename}\n${truncate(content, 4000)}`);
      }
    }

    if (input.session.compactSummary) {
      systemParts.push(`## Compact Summary\n${input.session.compactSummary}`);
    }

    const memory = new MemoryStore({ projectRoot: workspaceRoot });
    const memoryEntries = [...(await memory.listGlobalMemory()), ...(await memory.listProjectMemory())];
    if (memoryEntries.length > 0) {
      systemParts.push(`## Memory\n${memoryEntries.map((entry) => `- ${entry}`).join("\n")}`);
    }

    return {
      includedFiles,
      messages: [
        { role: "system", content: systemParts.join("\n\n") },
        ...recentMessages(input.session, this.options.maxRecentMessages ?? 20),
        { role: "user", content: input.userMessage }
      ]
    };
  }
}

function recentMessages(session: SessionState, maxRecentMessages: number): TDMessage[] {
  if (maxRecentMessages <= 0) {
    return [];
  }
  return session.messages.slice(-maxRecentMessages);
}

async function readOptionalText(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return undefined;
  }
}

function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }
  return `${value.slice(0, maxLength)}\n...[truncated ${value.length - maxLength} chars]`;
}
