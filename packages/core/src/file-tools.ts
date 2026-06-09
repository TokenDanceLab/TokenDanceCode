import { mkdir, readFile, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { isSecretLikePath } from "./permissions.js";
import type { PermissionSubject, PermissionSubjectFlag, ToolExecutionContext, ToolSpec } from "./types.js";

const excludedGlobParts = new Set([
  ".git",
  ".tokendance",
  ".pytest_cache",
  ".mypy_cache",
  ".ruff_cache",
  ".venv",
  "__pycache__",
  "build",
  "dist",
  "node_modules",
  "venv"
]);

const excludedGlobFiles = new Set([".env"]);

interface PathInput {
  path: string;
}

interface WriteInput extends PathInput {
  content: string;
}

interface EditInput extends PathInput {
  oldText: string;
  newText: string;
}

interface GlobInput {
  pattern: string;
}

export function buildFileTools(): ToolSpec[] {
  return [createReadFileTool(), createWriteFileTool(), createEditFileTool(), createGlobTool()];
}

export function createReadFileTool(): ToolSpec<PathInput, { path: string; content: string }> {
  return {
    name: "read_file",
    description: "Read a UTF-8 file by workspace-relative path.",
    risk: "read",
    concurrency: "parallel_safe",
    parse: parsePathInput,
    permissionSubjects: (input, context) => pathPermissionSubjects(input.path, context, "read"),
    async execute(input, context) {
      const path = resolveWorkspacePath(context, input.path);
      try {
        return { path: relativePath(context, path), content: await readFile(path, "utf8") };
      } catch (error) {
        if (isNodeError(error) && error.code === "ENOENT") {
          throw new Error(`File not found: ${input.path}`);
        }
        throw error;
      }
    }
  };
}

export function createWriteFileTool(): ToolSpec<WriteInput, { path: string; bytes: number }> {
  return {
    name: "write_file",
    description: "Write a complete UTF-8 file by workspace-relative path.",
    risk: "write",
    concurrency: "exclusive",
    parse(input) {
      const path = parsePathInput(input).path;
      if (typeof (input as { content?: unknown }).content !== "string") {
        throw new Error("write_file input requires a string content field");
      }
      return { path, content: (input as { content: string }).content };
    },
    permissionSubjects: (input, context) => pathPermissionSubjects(input.path, context, "write"),
    async execute(input, context) {
      const path = resolveWorkspacePath(context, input.path);
      await atomicWriteText(path, input.content);
      return { path: relativePath(context, path), bytes: Buffer.byteLength(input.content, "utf8") };
    }
  };
}

export function createEditFileTool(): ToolSpec<EditInput, { path: string; replacements: number }> {
  return {
    name: "edit_file",
    description: "Replace the first exact text match in a UTF-8 file.",
    risk: "write",
    concurrency: "exclusive",
    parse(input) {
      const path = parsePathInput(input).path;
      const raw = input as { oldText?: unknown; old_text?: unknown; newText?: unknown; new_text?: unknown };
      const oldText = raw.oldText ?? raw.old_text;
      const newText = raw.newText ?? raw.new_text;
      if (typeof oldText !== "string" || typeof newText !== "string") {
        throw new Error("edit_file input requires string oldText and newText fields");
      }
      return { path, oldText, newText };
    },
    permissionSubjects: (input, context) => pathPermissionSubjects(input.path, context, "edit"),
    async execute(input, context) {
      const path = resolveWorkspacePath(context, input.path);
      const content = await readFile(path, "utf8");
      if (!content.includes(input.oldText)) {
        throw new Error("oldText was not found");
      }
      await atomicWriteText(path, content.replace(input.oldText, input.newText));
      return { path: relativePath(context, path), replacements: 1 };
    }
  };
}

export function createGlobTool(): ToolSpec<GlobInput, { matches: string[] }> {
  return {
    name: "glob",
    description: "Find files by workspace-relative glob pattern. Internal and sensitive paths are excluded.",
    risk: "read",
    concurrency: "parallel_safe",
    parse(input) {
      if (typeof input !== "object" || input === null || typeof (input as { pattern?: unknown }).pattern !== "string") {
        throw new Error("glob input requires a string pattern field");
      }
      return { pattern: (input as { pattern: string }).pattern };
    },
    async permissionSubjects(input, context) {
      const root = resolve(context.cwd);
      const matches = await globMatches(root, input.pattern);
      return Promise.all(
        matches
          .filter((path) => isSecretLikePath(path))
          .map((path) => createPathPermissionSubject(path, context, "glob"))
      );
    },
    async execute(input, context) {
      const root = resolve(context.cwd);
      return { matches: await globMatches(root, input.pattern) };
    }
  };
}

function parsePathInput(input: unknown): PathInput {
  if (typeof input !== "object" || input === null || typeof (input as { path?: unknown }).path !== "string") {
    throw new Error("tool input requires a string path field");
  }
  return { path: (input as { path: string }).path };
}

async function pathPermissionSubjects(
  rawPath: string,
  context: ToolExecutionContext,
  operation: Extract<PermissionSubject, { kind: "path" }>["operation"]
): Promise<PermissionSubject[]> {
  return [await createPathPermissionSubject(rawPath, context, operation)];
}

async function createPathPermissionSubject(
  rawPath: string,
  context: ToolExecutionContext,
  operation: Extract<PermissionSubject, { kind: "path" }>["operation"]
): Promise<PermissionSubject> {
  const root = resolve(context.cwd);
  const candidate = resolve(root, rawPath);
  const normalizedPath = relativePathFromRoot(root, candidate);
  const flags = new Set<PermissionSubjectFlag>();
  if (isSecretLikePath(rawPath) || isSecretLikePath(normalizedPath)) {
    flags.add("secret_like");
  }

  let realRelativePath: string | undefined;
  if (isWithinRoot(root, candidate)) {
    const realCandidate = await realExistingOrProjectedPath(candidate);
    if (realCandidate) {
      const realRoot = await safeRealpath(root) ?? root;
      realRelativePath = relativePathFromRoot(realRoot, realCandidate);
      if (!isWithinRoot(realRoot, realCandidate)) {
        flags.add("workspace_escape");
      }
    }
  }

  return {
    kind: "path",
    operation,
    rawPath,
    normalizedPath,
    realPath: realRelativePath,
    flags: [...flags]
  };
}

async function globMatches(root: string, pattern: string): Promise<string[]> {
  const allFiles = await listFiles(root);
  return allFiles
    .map((path) => relative(root, path).split(sep).join("/"))
    .filter((path) => !isExcludedGlobMatch(path))
    .filter((path) => matchGlob(pattern, path))
    .sort();
}

function resolveWorkspacePath(context: ToolExecutionContext, rawPath: string): string {
  const root = resolve(context.cwd);
  const candidate = resolve(root, rawPath);
  const rel = relative(root, candidate);
  if (rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))) {
    return candidate;
  }
  throw new Error("Path is outside the workspace");
}

function relativePathFromRoot(root: string, path: string): string {
  const rel = relative(root, path);
  return (rel === "" ? "." : rel).split(sep).join("/");
}

async function realExistingOrProjectedPath(path: string): Promise<string | undefined> {
  const missingParts: string[] = [];
  let current = path;
  while (true) {
    const currentRealpath = await safeRealpath(current);
    if (currentRealpath) {
      return missingParts.length > 0 ? resolve(currentRealpath, ...missingParts.reverse()) : currentRealpath;
    }

    const parent = dirname(current);
    if (parent === current) {
      return undefined;
    }
    missingParts.push(basename(current));
    current = parent;
  }
}

async function safeRealpath(path: string): Promise<string | undefined> {
  try {
    return await realpath(path);
  } catch {
    return undefined;
  }
}

function isWithinRoot(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function relativePath(context: ToolExecutionContext, path: string): string {
  return relative(resolve(context.cwd), path).split(sep).join("/");
}

async function atomicWriteText(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tempPath = `${path}.tmp-${process.pid}-${Date.now()}`;
  try {
    await writeFile(tempPath, content, "utf8");
    await rename(tempPath, path);
  } catch (error) {
    await rm(tempPath, { force: true });
    throw error;
  }
}

async function listFiles(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const path = resolve(root, entry.name);
    if (entry.isDirectory()) {
      if (!excludedGlobParts.has(entry.name)) {
        files.push(...(await listFiles(path)));
      }
    } else if (entry.isFile()) {
      files.push(path);
    }
  }
  return files;
}

function isExcludedGlobMatch(relativeFile: string): boolean {
  const parts = relativeFile.split("/");
  const filename = parts.at(-1);
  return (filename !== undefined && excludedGlobFiles.has(filename)) || parts.some((part) => excludedGlobParts.has(part));
}

function matchGlob(pattern: string, relativeFile: string): boolean {
  const normalizedPattern = pattern.split("\\").join("/");
  if (normalizedPattern === "**/*") {
    return true;
  }
  if (!normalizedPattern.includes("/")) {
    return matchSegment(normalizedPattern, relativeFile) || matchSegment(normalizedPattern, relativeFile.split("/").at(-1) ?? "");
  }
  const regex = globToRegex(normalizedPattern);
  return regex.test(relativeFile);
}

function matchSegment(pattern: string, value: string): boolean {
  return globToRegex(pattern).test(value);
}

function globToRegex(pattern: string): RegExp {
  let source = "^";
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];
    const next = pattern[index + 1];
    if (char === "*" && next === "*") {
      source += ".*";
      index += 1;
    } else if (char === "*") {
      source += "[^/]*";
    } else if (char === "?") {
      source += "[^/]";
    } else {
      source += escapeRegex(char ?? "");
    }
  }
  source += "$";
  return new RegExp(source);
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
