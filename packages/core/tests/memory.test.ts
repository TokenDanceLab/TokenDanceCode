import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ContextBuilder, MemoryStore, type SessionState } from "../src/index.js";

describe("MemoryStore", () => {
  it("adds, lists, and deletes project memory", async () => {
    const root = await mkdtemp(join(tmpdir(), "tdcode-memory-"));
    const store = new MemoryStore({ projectRoot: root, homeDir: join(root, "home") });

    await store.addProjectMemory("Use Vitest for TS tests.");
    const entries = await store.listProjectMemory();
    await store.deleteProjectMemory(0);

    expect(entries).toEqual(["Use Vitest for TS tests."]);
    await expect(store.listProjectMemory()).resolves.toEqual([]);
  });

  it("stores global memory under the provided home directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "tdcode-memory-"));
    const store = new MemoryStore({ projectRoot: join(root, "repo"), homeDir: join(root, "home") });

    await store.addGlobalMemory("Prefer concise output.");

    await expect(store.listGlobalMemory()).resolves.toEqual(["Prefer concise output."]);
  });

  it("injects project memory into context", async () => {
    const root = await mkdtemp(join(tmpdir(), "tdcode-memory-"));
    await new MemoryStore({ projectRoot: root }).addProjectMemory("Keep SDK APIs stable.");

    const context = await new ContextBuilder().build({
      session: createSession(root),
      userMessage: "next"
    });

    expect(context.messages[0]?.content).toContain("## Memory");
    expect(context.messages[0]?.content).toContain("Keep SDK APIs stable.");
  });
});

function createSession(cwd: string): SessionState {
  return {
    id: "session-1",
    cwd,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    permissionMode: "default",
    messages: []
  };
}
