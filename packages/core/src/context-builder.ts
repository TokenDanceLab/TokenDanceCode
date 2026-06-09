import { open, readFile, realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { MemoryStore } from "./memory.js";
import type { SessionState, TDMessage } from "./types.js";

const defaultSystemPrompt = "TokenDanceCode is a local command-line coding agent. Keep responses concise, concrete, and action-oriented.";
const defaultMaxInstructionFileBytes = 64 * 1024;
const instructionFiles = ["AGENTS.md", "CLAUDE.md", ".tokendance/instructions.md", "README.md"] as const;

export interface ContextBuilderOptions {
  maxRecentMessages?: number;
  maxInstructionFileBytes?: number;
  systemPrompt?: string;
  contextBudget?: ContextBudget;
  memoryHomeDir?: string;
}

export interface ContextBudget {
  instructions?: number;
  compact?: number;
  memory?: number;
  recentMessages?: number;
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
  contextBudget?: ContextBudget;
  droppedRecentMessageCount: number;
}

export class ContextBuilder {
  constructor(private readonly options: ContextBuilderOptions = {}) {}

  async build(input: BuildContextInput): Promise<BuiltContext> {
    const includedFiles: string[] = [];
    const systemParts = [this.options.systemPrompt ?? defaultSystemPrompt];
    const workingDirectory = resolve(input.session.cwd);
    const workspaceRoot = await resolveWorkspaceRoot(workingDirectory, input.workspaceRoot);
    const maxInstructionFileBytes = this.options.maxInstructionFileBytes ?? defaultMaxInstructionFileBytes;

    const instructionParts: string[] = [];
    for (const instructionFile of await discoverInstructionFiles(workingDirectory, workspaceRoot)) {
      const content = await readOptionalText(instructionFile.absolutePath, maxInstructionFileBytes);
      if (content) {
        includedFiles.push(instructionFile.displayPath);
        instructionParts.push(`## ${instructionFile.displayPath}\n${content}`);
      }
    }
    const instructionContent = limitText(instructionParts.join("\n\n"), this.options.contextBudget?.instructions);
    if (instructionContent) {
      systemParts.push(instructionContent);
    }

    if (input.session.compactSummary) {
      const compactSummary = limitText(input.session.compactSummary, this.options.contextBudget?.compact);
      if (compactSummary) {
        systemParts.push(`## Compact Summary\n${compactSummary}`);
      }
    }

    const memory = new MemoryStore({ projectRoot: workspaceRoot, homeDir: this.options.memoryHomeDir });
    const memoryEntries = [...(await memory.listGlobalMemory()), ...(await memory.listProjectMemory())];
    if (memoryEntries.length > 0) {
      const memoryContent = limitText(memoryEntries.map((entry) => `- ${entry}`).join("\n"), this.options.contextBudget?.memory);
      if (memoryContent) {
        systemParts.push(`## Memory\n${memoryContent}`);
      }
    }
    const maxRecentMessages = this.options.maxRecentMessages ?? 20;
    const { messages: includedRecentMessages, droppedCount } = recentMessages(
      input.session,
      maxRecentMessages,
      this.options.contextBudget?.recentMessages
    );
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
        totalMessageCharacters: messages.reduce((total, message) => total + message.content.length, 0),
        contextBudget: this.options.contextBudget ? { ...this.options.contextBudget } : undefined,
        droppedRecentMessageCount: droppedCount
      }
    };
  }
}

function recentMessages(
  session: SessionState,
  maxRecentMessages: number,
  characterBudget?: number
): { messages: TDMessage[]; droppedCount: number } {
  if (maxRecentMessages <= 0) {
    return { messages: [], droppedCount: session.messages.length };
  }
  const candidates = session.messages.slice(-maxRecentMessages);
  const omittedByCount = Math.max(0, session.messages.length - candidates.length);
  if (characterBudget === undefined) {
    return { messages: candidates, droppedCount: omittedByCount };
  }
  if (characterBudget <= 0) {
    return { messages: [], droppedCount: omittedByCount + candidates.length };
  }

  const messages: TDMessage[] = [];
  let remaining = characterBudget;
  for (let index = candidates.length - 1; index >= 0; index -= 1) {
    const message = candidates[index];
    if (!message) {
      continue;
    }
    if (message.content.length <= remaining) {
      messages.unshift({ ...message });
      remaining -= message.content.length;
      continue;
    }
    if (messages.length === 0) {
      const content = limitText(message.content, remaining);
      if (content) {
        messages.unshift({ ...message, content });
      }
    }
    break;
  }

  return { messages, droppedCount: omittedByCount + candidates.length - messages.length };
}

function limitText(text: string, characterBudget?: number): string | undefined {
  if (characterBudget === undefined) {
    return text;
  }
  if (characterBudget <= 0) {
    return undefined;
  }
  if (text.length <= characterBudget) {
    return text;
  }

  let sliceLength = characterBudget;
  let marker = "";
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const omitted = Math.max(0, text.length - sliceLength);
    marker = `\n...[truncated ${omitted} characters]`;
    sliceLength = Math.max(0, characterBudget - marker.length);
  }
  if (sliceLength <= 0) {
    return text.slice(0, characterBudget);
  }
  const omitted = text.length - sliceLength;
  marker = `\n...[truncated ${omitted} characters]`;
  return `${text.slice(0, Math.max(0, characterBudget - marker.length))}${marker}`;
}

async function readOptionalText(path: string, maxBytes: number): Promise<string | undefined> {
  try {
    return await readLimitedText(path, maxBytes);
  } catch {
    return undefined;
  }
}

async function readLimitedText(path: string, maxBytes: number): Promise<string | undefined> {
  if (maxBytes <= 0) {
    return undefined;
  }
  const fileStat = await stat(path);
  if (!fileStat.isFile()) {
    return undefined;
  }
  if (fileStat.size <= maxBytes) {
    return readFile(path, "utf8");
  }

  const handle = await open(path, "r");
  try {
    const buffer = Buffer.alloc(maxBytes);
    const { bytesRead } = await handle.read(buffer, 0, maxBytes, 0);
    const content = buffer.subarray(0, bytesRead).toString("utf8");
    return `${content}\n...[truncated ${fileStat.size - bytesRead} bytes]`;
  } finally {
    await handle.close();
  }
}

interface InstructionFile {
  absolutePath: string;
  displayPath: string;
}

async function discoverInstructionFiles(workingDirectory: string, workspaceRoot: string): Promise<InstructionFile[]> {
  const directories = instructionDirectories(workingDirectory, workspaceRoot);
  const seen = new Set<string>();
  const files: InstructionFile[] = [];

  for (const directory of directories) {
    for (const filename of instructionFiles) {
      const absolutePath = join(directory, filename);
      const key = await realPathKey(absolutePath);
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      files.push({
        absolutePath,
        displayPath: toDisplayPath(relative(workspaceRoot, absolutePath))
      });
    }
  }

  return files;
}

function instructionDirectories(workingDirectory: string, workspaceRoot: string): string[] {
  if (!isInsideOrEqual(workingDirectory, workspaceRoot)) {
    return [workingDirectory];
  }

  const directories: string[] = [];
  let current = workingDirectory;
  while (isInsideOrEqual(current, workspaceRoot)) {
    directories.push(current);
    if (pathsEqual(current, workspaceRoot)) {
      break;
    }
    const parent = dirname(current);
    if (pathsEqual(parent, current)) {
      break;
    }
    current = parent;
  }

  return directories.reverse();
}

async function resolveWorkspaceRoot(workingDirectory: string, explicitWorkspaceRoot?: string): Promise<string> {
  if (explicitWorkspaceRoot) {
    const workspaceRoot = resolve(explicitWorkspaceRoot);
    return isInsideOrEqual(workingDirectory, workspaceRoot) ? workspaceRoot : workingDirectory;
  }
  return (await findGitRoot(workingDirectory)) ?? workingDirectory;
}

async function findGitRoot(startDirectory: string): Promise<string | undefined> {
  let current = startDirectory;
  while (true) {
    try {
      const gitStat = await stat(join(current, ".git"));
      if (gitStat.isDirectory() || gitStat.isFile()) {
        return current;
      }
    } catch {
      // Continue upward until the filesystem root; missing .git is expected.
    }

    const parent = dirname(current);
    if (pathsEqual(parent, current)) {
      return undefined;
    }
    current = parent;
  }
}

async function realPathKey(path: string): Promise<string> {
  try {
    return normalizePathKey(resolve(await realpath(path)));
  } catch {
    return normalizePathKey(resolve(path));
  }
}

function isInsideOrEqual(path: string, root: string): boolean {
  const relativePath = relative(root, path);
  return relativePath === "" || (!relativePath.startsWith("..") && !isAbsolute(relativePath));
}

function pathsEqual(left: string, right: string): boolean {
  return normalizePathKey(resolve(left)) === normalizePathKey(resolve(right));
}

function normalizePathKey(path: string): string {
  return process.platform === "win32" ? path.toLowerCase() : path;
}

function toDisplayPath(path: string): string {
  return path === "" ? "." : path.replaceAll("\\", "/");
}
