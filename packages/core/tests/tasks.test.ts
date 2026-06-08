import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { TaskStore, TodoStore } from "../src/index.js";

describe("task and todo stores", () => {
  it("persists task events and rebuilds the task index", async () => {
    const root = await mkdtemp(join(tmpdir(), "tdcode-tasks-"));
    const tasks = new TaskStore({ projectRoot: root });

    const created = await tasks.create({ title: "Stage 15 E2E", description: "README acceptance" });
    await tasks.addDependency(created.id, "task-prereq");
    await tasks.linkSession(created.id, "session-1");
    await tasks.linkWorktree(created.id, "wt-stage15");
    const completed = await tasks.updateStatus(created.id, "completed");

    expect(completed).toMatchObject({
      id: created.id,
      title: "Stage 15 E2E",
      status: "completed",
      dependencies: ["task-prereq"],
      linkedSessionId: "session-1",
      linkedWorktree: "wt-stage15"
    });
    expect(await tasks.get(created.id)).toEqual(completed);
    expect(await tasks.list()).toEqual([completed]);
    await expect(readFile(join(root, ".tokendance", "tasks", "tasks.jsonl"), "utf8")).resolves.toContain("task.created");
    await expect(readFile(join(root, ".tokendance", "tasks", "task-index.json"), "utf8")).resolves.toContain(created.id);
  });

  it("stores session todos with optional task linkage", async () => {
    const root = await mkdtemp(join(tmpdir(), "tdcode-todos-"));
    const todos = new TodoStore({ projectRoot: root, sessionId: "session-1" });

    const todo = await todos.add({ text: "Run unittest", taskId: "task-1" });
    const updated = await todos.updateStatus(todo.id, "in_progress");

    expect(updated).toMatchObject({
      id: todo.id,
      text: "Run unittest",
      status: "in_progress",
      taskId: "task-1"
    });
    expect(await todos.list()).toEqual([updated]);
    await expect(readFile(join(root, ".tokendance", "sessions", "session-1", "todos.json"), "utf8")).resolves.toContain("Run unittest");
  });

  it("rejects blank task titles and todo text", async () => {
    const root = await mkdtemp(join(tmpdir(), "tdcode-blank-tasks-"));
    const tasks = new TaskStore({ projectRoot: root });
    const todos = new TodoStore({ projectRoot: root });

    await expect(tasks.create({ title: "   " })).rejects.toThrow("Task title is required.");
    await expect(todos.add({ text: "   " })).rejects.toThrow("Todo text is required.");
  });
});
