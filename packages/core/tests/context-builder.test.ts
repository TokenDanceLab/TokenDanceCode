import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ContextBuilder, MemoryStore, type SessionState } from "../src/index.js";

describe("ContextBuilder", () => {
  it("builds system context from defaults, AGENTS.md, README.md, compact summary, and recent messages", async () => {
    const root = await mkdtemp(join(tmpdir(), "tdcode-context-"));
    await writeFile(join(root, "AGENTS.md"), "Use PowerShell.\n", "utf8");
    await writeFile(join(root, "CLAUDE.md"), "Prefer concise tool plans.\n", "utf8");
    await writeFile(join(root, "README.md"), "Project overview.\n", "utf8");
    const session = createSession(root);
    session.compactSummary = "Prior work summary.";
    session.messages = [
      { role: "user", content: "old 1" },
      { role: "assistant", content: "old 2" },
      { role: "user", content: "old 3" }
    ];

    const context = await new ContextBuilder({ maxRecentMessages: 2 }).build({
      session,
      userMessage: "next task"
    });

    expect(context.includedFiles).toEqual(["AGENTS.md", "CLAUDE.md", "README.md"]);
    expect(context.messages[0]).toMatchObject({ role: "system" });
    expect(context.messages[0]?.content).toContain("TokenDanceCode is a local command-line coding agent");
    expect(context.messages[0]?.content).toContain("Use PowerShell.");
    expect(context.messages[0]?.content).toContain("Prefer concise tool plans.");
    expect(context.messages[0]?.content).toContain("Project overview.");
    expect(context.messages[0]?.content).toContain("Prior work summary.");
    expect(context.messages.slice(1)).toEqual([
      { role: "assistant", content: "old 2" },
      { role: "user", content: "old 3" },
      { role: "user", content: "next task" }
    ]);
  });

  it("discovers layered workspace instructions from git root to working directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "tdcode-context-"));
    const child = join(root, "packages", "app");
    await mkdir(join(root, ".git"), { recursive: true });
    await mkdir(join(root, ".tokendance"), { recursive: true });
    await mkdir(child, { recursive: true });
    await writeFile(join(root, "AGENTS.md"), "Root agent rules.\n", "utf8");
    await writeFile(join(root, "CLAUDE.md"), "Root Claude rules.\n", "utf8");
    await writeFile(join(root, ".tokendance", "instructions.md"), "Root local instructions.\n", "utf8");
    await writeFile(join(child, "AGENTS.md"), "Package agent rules.\n", "utf8");
    await writeFile(join(child, "CLAUDE.md"), "Package Claude rules.\n", "utf8");

    const context = await new ContextBuilder().build({
      session: createSession(child),
      userMessage: "next task"
    });

    expect(context.includedFiles).toEqual([
      "AGENTS.md",
      "CLAUDE.md",
      ".tokendance/instructions.md",
      "packages/app/AGENTS.md",
      "packages/app/CLAUDE.md"
    ]);
    const systemContent = context.messages[0]?.content ?? "";
    expect(systemContent.indexOf("Root agent rules.")).toBeLessThan(systemContent.indexOf("Package agent rules."));
    expect(systemContent.indexOf("Root Claude rules.")).toBeLessThan(systemContent.indexOf("Package Claude rules."));
    expect(systemContent).toContain("Root local instructions.");
  });

  it("stops instruction discovery at the explicit workspace root and limits file reads", async () => {
    const outer = await mkdtemp(join(tmpdir(), "tdcode-context-"));
    const stopRoot = join(outer, "repo");
    const child = join(stopRoot, "nested");
    await mkdir(child, { recursive: true });
    await writeFile(join(outer, "AGENTS.md"), "Outer rules must not be read.\n", "utf8");
    await writeFile(join(stopRoot, "AGENTS.md"), "Stop root rules.\n", "utf8");
    await writeFile(join(child, "AGENTS.md"), "Child rules include only this prefix and then a long suffix.\n", "utf8");

    const context = await new ContextBuilder({ maxInstructionFileBytes: 24 }).build({
      session: createSession(child),
      userMessage: "next task",
      workspaceRoot: stopRoot
    });

    expect(context.includedFiles).toEqual(["AGENTS.md", "nested/AGENTS.md"]);
    const systemContent = context.messages[0]?.content ?? "";
    expect(systemContent).toContain("Stop root rules.");
    expect(systemContent).toContain("Child rules include only");
    expect(systemContent).toContain("[truncated");
    expect(systemContent).not.toContain("Outer rules must not be read.");
    expect(systemContent).not.toContain("long suffix");
  });

  it("applies context budgets to instructions, compact summary, memory, and recent messages", async () => {
    const root = await mkdtemp(join(tmpdir(), "tdcode-context-budget-"));
    const home = await mkdtemp(join(tmpdir(), "tdcode-context-budget-home-"));
    await writeFile(
      join(root, "AGENTS.md"),
      `instruction-anchor ${"x".repeat(120)} instruction-hidden\n`,
      "utf8"
    );
    await new MemoryStore({ projectRoot: root, homeDir: home }).addProjectMemory(`memory-anchor ${"y".repeat(120)} memory-hidden`);
    const session = createSession(root);
    session.compactSummary = `compact-anchor ${"z".repeat(120)} compact-hidden`;
    session.messages = [
      { role: "user", content: "older message should be dropped by the recent-message budget" },
      { role: "assistant", content: `assistant-anchor ${"a".repeat(120)} assistant-hidden` }
    ];

    const context = await new ContextBuilder({
      maxRecentMessages: 5,
      memoryHomeDir: home,
      contextBudget: {
        instructions: 72,
        compact: 64,
        memory: 60,
        recentMessages: 58
      }
    }).build({
      session,
      userMessage: "next task",
      workspaceRoot: root
    });

    const systemContent = context.messages[0]?.content ?? "";
    expect(systemContent).toContain("instruction-anchor");
    expect(systemContent).toContain("compact-anchor");
    expect(systemContent).toContain("memory-anchor");
    expect(systemContent).toContain("[truncated");
    expect(systemContent).not.toContain("instruction-hidden");
    expect(systemContent).not.toContain("compact-hidden");
    expect(systemContent).not.toContain("memory-hidden");
    expect(context.messages.slice(1)).toEqual([
      { role: "assistant", content: expect.stringContaining("assistant-anchor") },
      { role: "user", content: "next task" }
    ]);
    expect(context.messages[1]?.content.length).toBeLessThanOrEqual(58);
    expect(context.messages[1]?.content).not.toContain("assistant-hidden");
    expect(context.metadata.contextBudget).toMatchObject({
      instructions: 72,
      compact: 64,
      memory: 60,
      recentMessages: 58
    });
    expect(context.metadata.droppedRecentMessageCount).toBe(1);
  });
});

function createSession(cwd: string): SessionState {
  return {
    id: "session-1",
    cwd,
    createdAt: "2026-06-09T00:00:00.000Z",
    updatedAt: "2026-06-09T00:00:00.000Z",
    permissionMode: "default",
    messages: []
  };
}
