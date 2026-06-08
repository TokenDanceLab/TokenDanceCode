import { execFile } from "node:child_process";
import { Readable, Writable } from "node:stream";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { runCli, type CliIO } from "../src/main.js";

const execFileAsync = promisify(execFile);

describe("TokenDanceCode CLI", () => {
  it("prints version through the exported runner", async () => {
    const io = createTestIO();

    const exitCode = await runCli(["--version"], io);

    expect(exitCode).toBe(0);
    expect(io.stdoutText()).toBe("0.2.0-ts.0\n");
  });

  it("runs an interactive shell with status, permissions, normal turns, and exit", async () => {
    const io = createTestIO("/status\n/permissions safe\n/status\nhello cli\n/exit\n");

    const exitCode = await runCli([], io);
    const output = io.stdoutText();

    expect(exitCode).toBe(0);
    expect(output).toContain("TokenDanceCode 0.2.0-ts.0");
    expect(output).toContain("permissionMode: default");
    expect(output).toContain("permissionMode: safe");
    expect(output).toContain("Mock response: hello cli");
    expect(output).toContain("bye");
  });

  it("supports interactive doctor, resume, and compact commands", async () => {
    const root = await mkdtemp(join(tmpdir(), "tdcode-cli-"));
    const first = createTestIO("hello before resume\n/exit\n", root);
    await runCli([], first);
    const second = createTestIO("/doctor\n/resume\n/compact\n/exit\n", root);

    const exitCode = await runCli([], second);
    const output = second.stdoutText();

    expect(exitCode).toBe(0);
    expect(output).toContain("TokenDanceCode 0.2.0-ts.0");
    expect(output).toContain(`cwd ${root}`);
    expect(output).toContain("Resumed session ");
    expect(output).toContain("recent transcript events.");
    expect(output).toContain("Compact summary ");
    expect(output).toContain("Events: ");
  });

  it("manages project memory in interactive and top-level commands", async () => {
    const root = await mkdtemp(join(tmpdir(), "tdcode-cli-"));
    const interactive = createTestIO("/memory\n/memory add project Keep SDK stable\n/memory\n/exit\n", root);
    await runCli([], interactive);
    const topLevelList = createTestIO("", root);
    const topLevelDelete = createTestIO("", root);
    const afterDelete = createTestIO("", root);

    const listExitCode = await runCli(["memory"], topLevelList);
    const deleteExitCode = await runCli(["memory", "delete", "project", "0"], topLevelDelete);
    const afterDeleteExitCode = await runCli(["memory"], afterDelete);

    expect(interactive.stdoutText()).toContain("No project memory.");
    expect(interactive.stdoutText()).toContain("Added project memory.");
    expect(interactive.stdoutText()).toContain("project[0]: Keep SDK stable");
    expect(listExitCode).toBe(0);
    expect(topLevelList.stdoutText()).toContain("project[0]: Keep SDK stable");
    expect(deleteExitCode).toBe(0);
    expect(topLevelDelete.stdoutText()).toContain("Deleted project memory 0.");
    expect(afterDeleteExitCode).toBe(0);
    expect(afterDelete.stdoutText()).toContain("No project memory.");
  });

  it("prints effective config in interactive and top-level commands", async () => {
    const root = await mkdtemp(join(tmpdir(), "tdcode-cli-config-"));
    await mkdir(join(root, ".tokendance"), { recursive: true });
    await writeFile(
      join(root, ".tokendance", "config.json"),
      JSON.stringify({ provider: "anthropic-messages", model: "claude-test", permissionMode: "safe" }),
      "utf8"
    );
    const interactive = createTestIO("/config\n/exit\n", root);
    const topLevel = createTestIO("", root);

    await runCli([], interactive);
    const topLevelExitCode = await runCli(["config"], topLevel);

    expect(interactive.stdoutText()).toContain("provider: anthropic-messages");
    expect(interactive.stdoutText()).toContain("model: claude-test");
    expect(interactive.stdoutText()).toContain("permissionMode: safe");
    expect(interactive.stdoutText()).toContain("source: project ");
    expect(topLevelExitCode).toBe(0);
    expect(topLevel.stdoutText()).toContain("provider: anthropic-messages");
    expect(topLevel.stdoutText()).toContain("model: claude-test");
  });

  it("manages tasks and todos in interactive and top-level commands", async () => {
    const root = await mkdtemp(join(tmpdir(), "tdcode-cli-tasks-"));
    const interactive = createTestIO("/tasks create Stage 15 E2E\n/todo add Run unittest --task task-1\n/tasks done task-1\n/todo doing todo-1\n/tasks\n/todo\n/exit\n", root);
    await runCli([], interactive);
    const topLevelTasks = createTestIO("", root);
    const topLevelTodos = createTestIO("", root);

    const tasksExitCode = await runCli(["tasks"], topLevelTasks);
    const todosExitCode = await runCli(["todo"], topLevelTodos);

    expect(interactive.stdoutText()).toContain("Created task task-1.");
    expect(interactive.stdoutText()).toContain("Created todo todo-1.");
    expect(interactive.stdoutText()).toContain("Updated task task-1 to completed.");
    expect(interactive.stdoutText()).toContain("Updated todo todo-1 to in_progress.");
    expect(interactive.stdoutText()).toContain("[completed] task-1 Stage 15 E2E");
    expect(interactive.stdoutText()).toContain("[in_progress] todo-1 Run unittest (task task-1)");
    expect(tasksExitCode).toBe(0);
    expect(todosExitCode).toBe(0);
    expect(topLevelTasks.stdoutText()).toContain("[completed] task-1 Stage 15 E2E");
    expect(topLevelTodos.stdoutText()).toContain("[in_progress] todo-1 Run unittest (task task-1)");
  });

  it("manages worktrees in interactive and top-level commands", async () => {
    const root = await initRepo();
    const interactive = createTestIO("/worktree\n/worktree create cli-wt\n/worktree\n/worktree remove cli-wt\n/worktree\n/exit\n", root);
    await runCli([], interactive);
    const topLevelCreate = createTestIO("", root);
    const topLevelList = createTestIO("", root);
    const topLevelRemove = createTestIO("", root);

    const createExitCode = await runCli(["worktree", "create", "top-wt"], topLevelCreate);
    const listExitCode = await runCli(["worktree"], topLevelList);
    const removeExitCode = await runCli(["worktree", "remove", "top-wt"], topLevelRemove);

    expect(interactive.stdoutText()).toContain("No worktrees.");
    expect(interactive.stdoutText()).toContain("Created worktree cli-wt.");
    expect(interactive.stdoutText()).toContain("[codex/cli-wt] cli-wt");
    expect(interactive.stdoutText()).toContain("Removed worktree cli-wt.");
    expect(createExitCode).toBe(0);
    expect(listExitCode).toBe(0);
    expect(removeExitCode).toBe(0);
    expect(topLevelCreate.stdoutText()).toContain("Created worktree top-wt.");
    expect(topLevelList.stdoutText()).toContain("[codex/top-wt] top-wt");
    expect(topLevelRemove.stdoutText()).toContain("Removed worktree top-wt.");
  });

  it("renders git diff, review, and quality commands in interactive and top-level modes", async () => {
    const root = await initRepo();
    await writeFile(join(root, "notes.txt"), "old\nnew TODO\n", "utf8");
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({ scripts: { verify: "node -e \"console.log('cli auto quality')\"" } }),
      "utf8"
    );
    const interactive = createTestIO("/diff\n/review\n/quality\n/quality Get-ChildItem -Name\n/exit\n", root);
    await runCli([], interactive);
    const topLevelDiff = createTestIO("", root);
    const topLevelReview = createTestIO("", root);
    const topLevelQualityAuto = createTestIO("", root);
    const topLevelQuality = createTestIO("", root);

    const diffExitCode = await runCli(["diff"], topLevelDiff);
    const reviewExitCode = await runCli(["review"], topLevelReview);
    const qualityAutoExitCode = await runCli(["quality"], topLevelQualityAuto);
    const qualityExitCode = await runCli(["quality", "Get-ChildItem", "-Name"], topLevelQuality);

    expect(interactive.stdoutText()).toContain("+new TODO");
    expect(interactive.stdoutText()).toContain("[medium] Diff adds TODO text that may need a tracked follow-up.");
    expect(interactive.stdoutText()).toContain("Quality passed.");
    expect(interactive.stdoutText()).toContain("cli auto quality");
    expect(diffExitCode).toBe(0);
    expect(reviewExitCode).toBe(0);
    expect(qualityAutoExitCode).toBe(0);
    expect(qualityExitCode).toBe(0);
    expect(topLevelDiff.stdoutText()).toContain("+new TODO");
    expect(topLevelReview.stdoutText()).toContain("[medium] Diff adds TODO text that may need a tracked follow-up.");
    expect(topLevelQualityAuto.stdoutText()).toContain("cli auto quality");
    expect(topLevelQuality.stdoutText()).toContain("Quality passed.");
  });

  it("lists tool capabilities in interactive and top-level commands", async () => {
    const root = await mkdtemp(join(tmpdir(), "tdcode-cli-tools-"));
    const interactive = createTestIO("/tools\n/exit\n", root);
    await runCli([], interactive);
    const topLevel = createTestIO("", root);

    const exitCode = await runCli(["tools"], topLevel);

    expect(interactive.stdoutText()).toContain("[read/parallel_safe] read_file - Read a UTF-8 file by workspace-relative path.");
    expect(interactive.stdoutText()).toContain("[shell/exclusive] worktree_create - Create a managed git worktree under .worktrees.");
    expect(exitCode).toBe(0);
    expect(topLevel.stdoutText()).toContain("[shell/exclusive] quality_gate");
    expect(topLevel.stdoutText()).toContain("[shell/exclusive] worktree_remove");
    expect(topLevel.stdoutText()).toContain("[shell/exclusive] subagent_accept");
    expect(topLevel.stdoutText()).toContain("[shell/exclusive] subagent_discard");
  });

  it("runs and lists readonly subagents in interactive and top-level commands", async () => {
    const root = await mkdtemp(join(tmpdir(), "tdcode-cli-agents-"));
    const interactive = createTestIO("/agents\n/agents run reviewer Inspect CLI\n/agents\n/exit\n", root);
    await runCli([], interactive);
    const topLevel = createTestIO("", root);

    const exitCode = await runCli(["agents"], topLevel);

    expect(interactive.stdoutText()).toContain("No subagents.");
    expect(interactive.stdoutText()).toContain("agent-0001 [reviewer] reviewer subagent completed: Inspect CLI");
    expect(exitCode).toBe(0);
    expect(topLevel.stdoutText()).toContain("agent-0001 [reviewer] reviewer subagent completed: Inspect CLI");
  });

  it("runs coding subagents in managed worktrees from top-level commands", async () => {
    const root = await initRepo();
    const run = createTestIO("", root);
    const list = createTestIO("", root);

    const runExitCode = await runCli(["agents", "run", "coding", "--worktree", "cli-code", "Prepare", "isolated", "change"], run);
    const listExitCode = await runCli(["agents"], list);

    expect(runExitCode).toBe(0);
    expect(listExitCode).toBe(0);
    expect(run.stdoutText()).toContain("agent-0001 [coding] coding subagent prepared worktree cli-code: Prepare isolated change");
    expect(run.stdoutText()).toContain(".worktrees");
    expect(list.stdoutText()).toContain("agent-0001 [coding] coding subagent prepared worktree cli-code: Prepare isolated change");
    await expect(readFile(join(root, ".tokendance", "agents", "agents.json"), "utf8")).resolves.toContain("\"agentType\": \"coding\"");
    await expect(readFile(join(root, ".worktrees", "cli-code", "notes.txt"), "utf8")).resolves.toContain("old");
    await expect(readFile(join(root, "agent.txt"), "utf8")).rejects.toThrow();
  });

  it("shows and discards coding subagent worktrees from top-level commands", async () => {
    const root = await initRepo();
    const run = createTestIO("", root);
    const show = createTestIO("", root);
    const discardDirty = createTestIO("", root);
    const discard = createTestIO("", root);
    const list = createTestIO("", root);

    await runCli(["agents", "run", "coding", "--worktree", "cli-discard", "Prepare", "discard"], run);
    await writeFile(join(root, ".worktrees", "cli-discard", "agent.txt"), "dirty cli worktree\n", "utf8");

    const showExitCode = await runCli(["agents", "show", "agent-0001"], show);
    const discardDirtyExitCode = await runCli(["agents", "discard", "agent-0001"], discardDirty);
    const discardExitCode = await runCli(["agents", "discard", "agent-0001", "--discard"], discard);
    const listExitCode = await runCli(["agents"], list);

    expect(showExitCode).toBe(0);
    expect(show.stdoutText()).toContain("agent-0001 [coding] completed");
    expect(show.stdoutText()).toContain("worktree: cli-discard");
    expect(discardDirtyExitCode).toBe(1);
    expect(discardDirty.stderrText()).toContain("uncommitted changes");
    expect(discardExitCode).toBe(0);
    expect(discard.stdoutText()).toContain("Discarded subagent agent-0001 worktree cli-discard.");
    expect(listExitCode).toBe(0);
    expect(list.stdoutText()).toContain("agent-0001 [coding] [discarded]");
    await expect(readFile(join(root, ".worktrees", "cli-discard", "agent.txt"), "utf8")).rejects.toThrow();
  });

  it("accepts coding subagent worktrees from top-level commands", async () => {
    const root = await initRepo();
    const run = createTestIO("", root);
    const accept = createTestIO("", root);
    const list = createTestIO("", root);

    await runCli(["agents", "run", "coding", "--worktree", "cli-accept", "Prepare", "accept"], run);
    await writeFile(join(root, ".worktrees", "cli-accept", "accepted.txt"), "accepted cli worktree\n", "utf8");

    const acceptExitCode = await runCli(["agents", "accept", "agent-0001", "--discard-worktree"], accept);
    const listExitCode = await runCli(["agents"], list);

    expect(acceptExitCode).toBe(0);
    expect(accept.stdoutText()).toContain("Accepted subagent agent-0001 worktree cli-accept.");
    expect(listExitCode).toBe(0);
    expect(list.stdoutText()).toContain("agent-0001 [coding] [accepted]");
    await expect(readFile(join(root, "accepted.txt"), "utf8")).resolves.toContain("accepted cli worktree");
    await expect(readFile(join(root, ".worktrees", "cli-accept", "accepted.txt"), "utf8")).rejects.toThrow();
  });

  it("shows transcript metadata in interactive and top-level commands", async () => {
    const root = await mkdtemp(join(tmpdir(), "tdcode-cli-"));
    const interactive = createTestIO("hello transcript\n/transcript\n/exit\n", root);
    await runCli([], interactive);
    const sessionId = interactive.stdoutText().match(/sessionId: ([^\n]+)/)?.[1]?.trim();
    const latest = createTestIO("", root);
    const byId = createTestIO("", root);

    const latestExitCode = await runCli(["transcript"], latest);
    const byIdExitCode = await runCli(["transcript", sessionId ?? ""], byId);

    expect(sessionId).toBeDefined();
    expect(interactive.stdoutText()).toContain("Transcript ");
    expect(interactive.stdoutText()).toContain("Events: 4");
    expect(latestExitCode).toBe(0);
    expect(byIdExitCode).toBe(0);
    expect(latest.stdoutText()).toContain(`sessionId: ${sessionId}`);
    expect(byId.stdoutText()).toContain(`sessionId: ${sessionId}`);
    expect(byId.stdoutText()).toContain("transcript.jsonl");
  });

  it("searches transcript content in interactive and top-level commands", async () => {
    const root = await mkdtemp(join(tmpdir(), "tdcode-cli-"));
    const interactive = createTestIO("/status\nhello search needle\n/transcript search needle\n/transcript search absent\n/exit\n", root);
    await runCli([], interactive);
    const sessionId = interactive.stdoutText().match(/sessionId: ([^\n]+)/)?.[1]?.trim();
    const latest = createTestIO("", root);
    const byId = createTestIO("", root);

    const latestExitCode = await runCli(["transcript", "search", "needle"], latest);
    const byIdExitCode = await runCli(["transcript", sessionId ?? "", "search", "needle"], byId);

    expect(sessionId).toBeDefined();
    expect(interactive.stdoutText()).toContain("seq 1 user.message");
    expect(interactive.stdoutText()).toContain("needle");
    expect(interactive.stdoutText()).toContain("No transcript matches.");
    expect(latestExitCode).toBe(0);
    expect(byIdExitCode).toBe(0);
    expect(latest.stdoutText()).toContain("seq 1 user.message");
    expect(byId.stdoutText()).toContain("seq 1 user.message");
  });

  it("supports top-level resume latest and by session id", async () => {
    const root = await mkdtemp(join(tmpdir(), "tdcode-cli-"));
    const first = createTestIO("/status\nhello for resume\n/exit\n", root);
    await runCli([], first);
    const sessionId = first.stdoutText().match(/sessionId: ([^\n]+)/)?.[1]?.trim();
    const latest = createTestIO("", root);
    const byId = createTestIO("", root);

    const latestExitCode = await runCli(["resume"], latest);
    const byIdExitCode = await runCli(["resume", sessionId ?? ""], byId);

    expect(sessionId).toBeDefined();
    expect(latestExitCode).toBe(0);
    expect(byIdExitCode).toBe(0);
    expect(latest.stdoutText()).toContain(`Resumed session ${sessionId}`);
    expect(byId.stdoutText()).toContain(`Resumed session ${sessionId}`);
    expect(latest.stdoutText()).toContain("recent transcript events.");
  });

  it("supports top-level compact latest and by session id", async () => {
    const root = await mkdtemp(join(tmpdir(), "tdcode-cli-"));
    const first = createTestIO("/status\nhello for compact\n/exit\n", root);
    await runCli([], first);
    const sessionId = first.stdoutText().match(/sessionId: ([^\n]+)/)?.[1]?.trim();
    const latest = createTestIO("", root);
    const byId = createTestIO("", root);

    const latestExitCode = await runCli(["compact"], latest);
    const byIdExitCode = await runCli(["compact", sessionId ?? ""], byId);

    expect(sessionId).toBeDefined();
    expect(latestExitCode).toBe(0);
    expect(byIdExitCode).toBe(0);
    expect(latest.stdoutText()).toContain("Compact summary ");
    expect(latest.stdoutText()).toContain("Events: 4");
    expect(byId.stdoutText()).toContain(sessionId);
    expect(byId.stdoutText()).toContain("compact-0002.md");
  });

  it("renders runtime events for interactive tool calls", async () => {
    const io = createTestIO("echo: hello renderer\n/exit\n");

    const exitCode = await runCli([], io);
    const output = io.stdoutText();

    expect(exitCode).toBe(0);
    expect(output).toContain("tool echo started");
    expect(output).toContain("permission allowed");
    expect(output).toContain("tool echo completed");
    expect(output).toMatch(/tool echo completed: .* duration=\d+ms/);
    expect(output).toContain('Tool result: {"text":"hello renderer"}');
    expect(output).toContain("usage input=1 output=10");
  });

  it("renders token usage for direct assistant turns", async () => {
    const io = createTestIO("hello usage\n/exit\n");

    const exitCode = await runCli([], io);
    const output = io.stdoutText();

    expect(exitCode).toBe(0);
    expect(output).toContain("Mock response: hello usage");
    expect(output).toContain("usage input=11 output=5");
  });

  it("renders compact summaries for successful tool results", async () => {
    const io = createTestIO("echo: short result\n/exit\n");

    const exitCode = await runCli([], io);
    const output = io.stdoutText();

    expect(exitCode).toBe(0);
    expect(output).toContain('tool echo completed: {"text":"short result"}');
  });

  it("truncates long successful tool result summaries", async () => {
    const longText = "x".repeat(180);
    const io = createTestIO(`echo: ${longText}\n/exit\n`);

    const exitCode = await runCli([], io);
    const output = io.stdoutText();
    const summaryLine = output.split("\n").find((line) => line.startsWith("tool echo completed:"));

    expect(exitCode).toBe(0);
    expect(summaryLine).toBeDefined();
    expect(summaryLine?.length).toBeLessThanOrEqual(190);
    expect(summaryLine).toContain("... omitted ");
    expect(summaryLine).toMatch(/duration=\d+ms/);
  });

  it("renders tool failure reasons", async () => {
    const io = createTestIO("missingtool: renderer\n/exit\n");

    const exitCode = await runCli([], io);
    const output = io.stdoutText();

    expect(exitCode).toBe(0);
    expect(output).toContain("tool missing_tool started");
    expect(output).toMatch(/tool missing_tool failed: Unknown tool: missing_tool duration=\d+ms/);
  });

  it("starts a fresh interactive session with /new", async () => {
    const io = createTestIO("hello old session\n/status\n/new\n/status\n/exit\n");

    const exitCode = await runCli([], io);
    const output = io.stdoutText();
    const newSessionOutput = output.slice(output.indexOf("Started new session "));

    expect(exitCode).toBe(0);
    expect(output).toContain("Mock response: hello old session");
    expect(output).toContain("messages: 2");
    expect(newSessionOutput).toContain("Started new session ");
    expect(newSessionOutput).toContain("messages: 0");
  });
});

function createTestIO(input = "", cwd = "D:/workspace"): CliIO & { stdoutText(): string; stderrText(): string } {
  let stdout = "";
  let stderr = "";
  return {
    stdin: Readable.from(input),
    stdout: new Writable({
      write(chunk, _encoding, callback) {
        stdout += chunk.toString();
        callback();
      }
    }),
    stderr: new Writable({
      write(chunk, _encoding, callback) {
        stderr += chunk.toString();
        callback();
      }
    }),
    cwd: () => cwd,
    stdoutText: () => stdout,
    stderrText: () => stderr
  };
}

async function initRepo(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "tdcode-cli-git-"));
  await execFileAsync("git", ["init"], { cwd: root });
  await execFileAsync("git", ["config", "user.email", "test@example.com"], { cwd: root });
  await execFileAsync("git", ["config", "user.name", "TokenDance Test"], { cwd: root });
  await writeFile(join(root, "notes.txt"), "old\n", "utf8");
  await execFileAsync("git", ["add", "."], { cwd: root });
  await execFileAsync("git", ["commit", "-m", "initial"], { cwd: root });
  return root;
}
