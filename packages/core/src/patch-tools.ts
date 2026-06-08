import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import type { ToolExecutionContext, ToolSpec } from "./types.js";

interface ApplyPatchInput {
  patch: string;
}

interface ParsedUpdatePatch {
  targetPath: string;
  oldText: string;
  newText: string;
}

export function createApplyPatchTool(): ToolSpec<ApplyPatchInput, { path: string; replacements: number }> {
  return {
    name: "apply_patch",
    description: "Apply a small text update patch inside the workspace.",
    risk: "write",
    concurrency: "exclusive",
    parse(input) {
      if (typeof input !== "object" || input === null || typeof (input as { patch?: unknown }).patch !== "string") {
        throw new Error("apply_patch input requires a string patch field");
      }
      return { patch: (input as { patch: string }).patch };
    },
    async execute(input, context) {
      const parsed = parseSimpleUpdatePatch(input.patch);
      if (!parsed) {
        throw new Error("Unsupported patch format");
      }
      const path = resolveWorkspacePath(context, parsed.targetPath);
      const content = await readFile(path, "utf8");
      if (!content.includes(parsed.oldText)) {
        throw new Error("Patch old text was not found");
      }
      await atomicWriteText(path, content.replace(parsed.oldText, parsed.newText));
      return { path: relative(context.cwd, path).split("\\").join("/"), replacements: 1 };
    }
  };
}

export function parseSimpleUpdatePatch(patch: string): ParsedUpdatePatch | null {
  const lines = patch.split(/\r?\n/);
  let targetPath: string | undefined;
  const oldLines: string[] = [];
  const newLines: string[] = [];

  for (const line of lines) {
    if (line.startsWith("*** Update File: ")) {
      targetPath = line.slice("*** Update File: ".length).trim();
    } else if (line.startsWith("-") && !line.startsWith("---")) {
      oldLines.push(line.slice(1));
    } else if (line.startsWith("+") && !line.startsWith("+++")) {
      newLines.push(line.slice(1));
    }
  }

  if (!targetPath || oldLines.length === 0) {
    return null;
  }

  return {
    targetPath,
    oldText: oldLines.join("\n"),
    newText: newLines.join("\n")
  };
}

function resolveWorkspacePath(context: ToolExecutionContext, rawPath: string): string {
  const root = resolve(context.cwd);
  const candidate = resolve(root, rawPath);
  const rel = relative(root, candidate);
  if (rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))) {
    return candidate;
  }
  throw new Error("Patch target is outside the workspace");
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
