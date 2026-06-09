import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { AgentManager, createDefaultToolRegistry, ToolOrchestrator, type SessionState, type SubagentRequest } from "../src/index.js";

const execFileAsync = promisify(execFile);

describe("agent manager", () => {
  it("runs readonly subagents and records an index plus transcript", async () => {
    const root = await mkdtemp(join(tmpdir(), "tdcode-agents-"));
    const manager = new AgentManager({
      projectRoot: root,
      runner: async (request: SubagentRequest) => {
        expect(request.readonly).toBe(true);
        expect(request.agentType).toBe("investigator");
        return { summary: `inspected: ${request.prompt}` };
      }
    });

    const result = await manager.runReadonly("Inspect task store");

    expect(result).toMatchObject({
      id: "agent-0001",
      agentType: "investigator",
      readonly: true,
      summary: "inspected: Inspect task store",
      changedFiles: [],
      diff: ""
    });
    expect(await manager.list()).toEqual([result]);
    expect(result.transcriptPath.endsWith("events.jsonl")).toBe(true);
    expect(result.transcriptPath).not.toContain("transcript.jsonl");
    await expect(readFile(result.transcriptPath, "utf8")).resolves.toContain("subagent_completed");
    await expect(readFile(join(root, ".tokendance", "agents", "agents.json"), "utf8")).resolves.toContain("agent-0001");
  });

  it("runs coding subagents in managed worktrees and reports changes", async () => {
    const root = await initRepo();
    const manager = new AgentManager({
      projectRoot: root,
      runner: async (request: SubagentRequest) => {
        expect(request.readonly).toBe(false);
        expect(request.cwd).not.toBe(root);
        await writeFile(join(request.cwd, "agent.txt"), "hello from subagent\n", "utf8");
        return { summary: "created agent file", validationResult: "manual validation" };
      }
    });

    const result = await manager.runCoding("Create an agent file", { worktree: "agent-file", taskId: "task-1" });

    expect(result).toMatchObject({
      id: "agent-0001",
      agentType: "coding",
      readonly: false,
      worktree: "agent-file",
      taskId: "task-1",
      summary: "created agent file",
      changedFiles: ["agent.txt"],
      worktreeDirty: true,
      worktreeDirtyFiles: ["agent.txt"],
      validationResult: "manual validation"
    });
    await expect(manager.get(result.id)).resolves.toMatchObject({ taskId: "task-1", worktreeDirty: true, worktreeDirtyFiles: ["agent.txt"] });
    await expect(manager.metadata()).resolves.toMatchObject({
      projectRoot: root,
      runCount: 1,
      codingCount: 1,
      readonlyCount: 0,
      completedCount: 1,
      dirtyWorktreeCount: 1,
      linkedTaskCount: 1,
      latestAgentId: result.id
    });
    expect(result.diff).toContain("+hello from subagent");
    await expect(readFile(join(root, "agent.txt"), "utf8")).rejects.toThrow();
  });

  it("gets and discards coding subagent worktrees with dirty-change protection", async () => {
    const root = await initRepo();
    const manager = new AgentManager({
      projectRoot: root,
      runner: async (request: SubagentRequest) => {
        await writeFile(join(request.cwd, "agent.txt"), "dirty subagent file\n", "utf8");
        return { summary: "created dirty file" };
      }
    });
    const result = await manager.runCoding("Create dirty file", { worktree: "dirty-agent" });

    await expect(manager.get(result.id)).resolves.toMatchObject({
      id: result.id,
      worktree: "dirty-agent",
      status: "completed"
    });
    await expect(manager.discard(result.id)).rejects.toMatchObject({
      message: "Worktree dirty-agent has uncommitted changes: agent.txt",
      dirtyFiles: ["agent.txt"]
    });

    const discarded = await manager.discard(result.id, { discard: true });

    expect(discarded).toMatchObject({
      id: result.id,
      status: "discarded",
      worktree: "dirty-agent"
    });
    await expect(manager.get(result.id)).resolves.toMatchObject({ status: "discarded" });
    await expect(readFile(join(root, ".worktrees", "dirty-agent", "agent.txt"), "utf8")).rejects.toThrow();
  });

  it("accepts coding subagent worktree changes with target dirty protection", async () => {
    const root = await initRepo();
    const manager = new AgentManager({
      projectRoot: root,
      runner: async (request: SubagentRequest) => {
        await writeFile(join(request.cwd, "agent.txt"), "accepted subagent file\n", "utf8");
        return { summary: "created accepted file" };
      }
    });
    const result = await manager.runCoding("Create accepted file", { worktree: "accepted-agent" });
    await writeFile(join(root, "target-dirty.txt"), "dirty target\n", "utf8");

    await expect(manager.accept(result.id)).rejects.toMatchObject({
      message: "Target repository has uncommitted changes: target-dirty.txt",
      dirtyFiles: ["target-dirty.txt"]
    });

    await rm(join(root, "target-dirty.txt"));
    const accepted = await manager.accept(result.id, { discardWorktree: true });

    expect(accepted).toMatchObject({
      id: result.id,
      status: "accepted",
      worktree: "accepted-agent",
      changedFiles: ["agent.txt"]
    });
    await expect(readFile(join(root, "agent.txt"), "utf8")).resolves.toContain("accepted subagent file");
    await expect(manager.get(result.id)).resolves.toMatchObject({ status: "accepted" });
    await expect(readFile(join(root, ".worktrees", "accepted-agent", "agent.txt"), "utf8")).rejects.toThrow();
  });

  it("exposes subagent tools through the default registry", async () => {
    const root = await initRepo();
    const orchestrator = new ToolOrchestrator(createDefaultToolRegistry());

    const run = await orchestrator.execute(
      { id: "subagent-run", name: "subagent_run", input: { prompt: "Inspect registry", agentType: "reviewer" } },
      { ...createSession(root), permissionMode: "yolo" }
    );
    const list = await orchestrator.execute({ id: "subagent-list", name: "subagent_list", input: {} }, createSession(root));
    const coding = await orchestrator.execute(
      { id: "subagent-coding", name: "subagent_run", input: { prompt: "Prepare tool worktree", agentType: "coding", worktree: "tool-agent" } },
      { ...createSession(root), permissionMode: "yolo" }
    );
    const get = await orchestrator.execute({ id: "subagent-get", name: "subagent_get", input: { id: "agent-0002" } }, createSession(root));
    await writeFile(join(root, ".worktrees", "tool-agent", "agent.txt"), "dirty tool worktree\n", "utf8");
    const accept = await orchestrator.execute(
      { id: "subagent-accept", name: "subagent_accept", input: { id: "agent-0002", discardWorktree: true } },
      { ...createSession(root), permissionMode: "yolo" }
    );
    const acceptedGet = await orchestrator.execute({ id: "subagent-get-accepted", name: "subagent_get", input: { id: "agent-0002" } }, createSession(root));
    const secondCoding = await orchestrator.execute(
      { id: "subagent-coding-discard", name: "subagent_run", input: { prompt: "Prepare discard worktree", agentType: "coding", worktree: "tool-discard-agent" } },
      { ...createSession(root), permissionMode: "yolo" }
    );
    await writeFile(join(root, ".worktrees", "tool-discard-agent", "discard.txt"), "discard tool worktree\n", "utf8");
    const dirtyDiscard = await orchestrator.execute(
      { id: "subagent-discard-dirty", name: "subagent_discard", input: { id: "agent-0003" } },
      { ...createSession(root), permissionMode: "yolo" }
    );
    const discard = await orchestrator.execute(
      { id: "subagent-discard", name: "subagent_discard", input: { id: "agent-0003", discard: true } },
      { ...createSession(root), permissionMode: "yolo" }
    );
    const discardedGet = await orchestrator.execute({ id: "subagent-get-discarded", name: "subagent_get", input: { id: "agent-0003" } }, createSession(root));

    expect(run).toMatchObject({ ok: true });
    expect(JSON.stringify(run.output)).toContain("reviewer subagent completed: Inspect registry");
    expect(list).toMatchObject({ ok: true });
    expect(JSON.stringify(list.output)).toContain("agent-0001");
    expect(coding).toMatchObject({ ok: true });
    expect(get).toMatchObject({ ok: true });
    expect(JSON.stringify(get.output)).toContain("tool-agent");
    expect(accept).toMatchObject({ ok: true });
    expect(JSON.stringify(accept.output)).toContain("\"status\":\"accepted\"");
    expect(JSON.stringify(acceptedGet.output)).toContain("\"status\":\"accepted\"");
    expect(secondCoding).toMatchObject({ ok: true });
    expect(dirtyDiscard).toMatchObject({ ok: false });
    expect(dirtyDiscard.error).toContain("uncommitted changes");
    expect(discard).toMatchObject({ ok: true });
    expect(JSON.stringify(discard.output)).toContain("\"status\":\"discarded\"");
    expect(JSON.stringify(discardedGet.output)).toContain("\"status\":\"discarded\"");
  });
});

async function initRepo(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "tdcode-agent-repo-"));
  await execFileAsync("git", ["init"], { cwd: root });
  await execFileAsync("git", ["config", "user.email", "test@example.com"], { cwd: root });
  await execFileAsync("git", ["config", "user.name", "TokenDance Test"], { cwd: root });
  await writeFile(join(root, "notes.txt"), "base\n", "utf8");
  await execFileAsync("git", ["add", "."], { cwd: root });
  await execFileAsync("git", ["commit", "-m", "initial"], { cwd: root });
  return root;
}

function createSession(cwd: string): SessionState {
  return {
    id: "test-session",
    cwd,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    permissionMode: "default",
    messages: []
  };
}
