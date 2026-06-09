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
  metadata: ContextPreviewMetadata;
}

export interface ContextPreviewMetadata {
  workspaceRoot: string;
  maxRecentMessages: number;
  sessionMessageCount: number;
  includedRecentMessageCount: number;
  includedFiles: string[];
  hasCompactSummary: boolean;
  memoryEntryCount: number;
  systemMessageCharacters: number;
  totalMessageCharacters: number;
}

export class ContextBuilder {
  constructor(private readonly options: ContextBuilderOptions = {}) {}

  async build(input: BuildContextInput): Promise<BuiltContext> {
    const includedFiles: string[] = [];
    const systemParts = [this.options.systemPrompt ?? defaultSystemPrompt];
    const workspaceRoot = input.workspaceRoot ?? input.session.cwd;

    for (const filename of ["AGENTS.md", "CLAUDE.md", "README.md"]) {
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
    const maxRecentMessages = this.options.maxRecentMessages ?? 20;
    const includedRecentMessages = recentMessages(input.session, maxRecentMessages);
    const systemContent = systemParts.join("\n\n");
    const messages = [
      { role: "system" as const, content: systemContent },
      ...includedRecentMessages,
      { role: "user" as const, content: input.userMessage }
    ];

    return {
      includedFiles,
      messages,
      metadata: {
        workspaceRoot,
        maxRecentMessages,
        sessionMessageCount: input.session.messages.length,
        includedRecentMessageCount: includedRecentMessages.length,
        includedFiles: [...includedFiles],
        hasCompactSummary: Boolean(input.session.compactSummary),
        memoryEntryCount: memoryEntries.length,
        systemMessageCharacters: systemContent.length,
        totalMessageCharacters: messages.reduce((total, message) => total + message.content.length, 0)
      }
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
