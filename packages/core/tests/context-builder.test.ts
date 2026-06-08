import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ContextBuilder, type SessionState } from "../src/index.js";

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
