import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export type TaskStatus = "open" | "in_progress" | "completed";
export type TodoStatus = "pending" | "in_progress" | "completed";

export interface TaskRecord {
  id: string;
  title: string;
  description: string;
  status: TaskStatus;
  dependencies: string[];
  linkedSessionId?: string;
  linkedWorktree?: string;
  createdAt: string;
  updatedAt: string;
}

export interface TodoRecord {
  id: string;
  text: string;
  status: TodoStatus;
  taskId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface TaskStoreOptions {
  projectRoot: string;
}

export interface TaskStoreMetadata {
  projectRoot: string;
  taskCount: number;
  openCount: number;
  inProgressCount: number;
  completedCount: number;
  linkedSessionCount: number;
  linkedWorktreeCount: number;
  dependencyEdgeCount: number;
  latestTaskId?: string;
}

export interface TodoStoreOptions {
  projectRoot: string;
  sessionId?: string;
}

export interface TodoStoreMetadata {
  projectRoot: string;
  sessionId?: string;
  todoCount: number;
  pendingCount: number;
  inProgressCount: number;
  completedCount: number;
  linkedTaskCount: number;
}

type TaskEvent =
  | { type: "task.created"; task: TaskRecord }
  | { type: "task.status_updated"; taskId: string; status: TaskStatus; updatedAt: string }
  | { type: "task.dependency_added"; taskId: string; dependencyId: string; updatedAt: string }
  | { type: "task.session_linked"; taskId: string; sessionId: string; updatedAt: string }
  | { type: "task.worktree_linked"; taskId: string; worktree: string; updatedAt: string };

export class TaskStore {
  constructor(private readonly options: TaskStoreOptions) {}

  async create(input: { title: string; description?: string }): Promise<TaskRecord> {
    const now = new Date().toISOString();
    const tasks = await this.list();
    const title = input.title.trim();
    if (!title) {
      throw new Error("Task title is required.");
    }
    const task: TaskRecord = {
      id: `task-${tasks.length + 1}`,
      title,
      description: input.description?.trim() ?? "",
      status: "open",
      dependencies: [],
      createdAt: now,
      updatedAt: now
    };
    await this.appendEvent({ type: "task.created", task });
    return task;
  }

  async list(): Promise<TaskRecord[]> {
    return [...(await this.readIndex()).values()];
  }

  async get(id: string): Promise<TaskRecord | undefined> {
    return (await this.readIndex()).get(id);
  }

  async metadata(): Promise<TaskStoreMetadata> {
    const tasks = await this.list();
    return {
      projectRoot: this.options.projectRoot,
      taskCount: tasks.length,
      openCount: tasks.filter((task) => task.status === "open").length,
      inProgressCount: tasks.filter((task) => task.status === "in_progress").length,
      completedCount: tasks.filter((task) => task.status === "completed").length,
      linkedSessionCount: tasks.filter((task) => Boolean(task.linkedSessionId)).length,
      linkedWorktreeCount: tasks.filter((task) => Boolean(task.linkedWorktree)).length,
      dependencyEdgeCount: tasks.reduce((total, task) => total + task.dependencies.length, 0),
      latestTaskId: tasks.at(-1)?.id
    };
  }

  async updateStatus(id: string, status: TaskStatus): Promise<TaskRecord> {
    return this.mutate(id, { type: "task.status_updated", taskId: id, status, updatedAt: new Date().toISOString() });
  }

  async addDependency(id: string, dependencyId: string): Promise<TaskRecord> {
    return this.mutate(id, { type: "task.dependency_added", taskId: id, dependencyId, updatedAt: new Date().toISOString() });
  }

  async linkSession(id: string, sessionId: string): Promise<TaskRecord> {
    return this.mutate(id, { type: "task.session_linked", taskId: id, sessionId, updatedAt: new Date().toISOString() });
  }

  async linkWorktree(id: string, worktree: string): Promise<TaskRecord> {
    return this.mutate(id, { type: "task.worktree_linked", taskId: id, worktree, updatedAt: new Date().toISOString() });
  }

  private async mutate(id: string, event: TaskEvent): Promise<TaskRecord> {
    const existing = await this.get(id);
    if (!existing) {
      throw new Error(`Task ${id} was not found.`);
    }
    await this.appendEvent(event);
    const updated = await this.get(id);
    if (!updated) {
      throw new Error(`Task ${id} was not found.`);
    }
    return updated;
  }

  private async appendEvent(event: TaskEvent): Promise<void> {
    const path = this.eventsPath();
    await mkdir(dirname(path), { recursive: true });
    const existing = await readOptional(path);
    await writeFile(path, `${existing}${JSON.stringify(event)}\n`, "utf8");
    await this.writeIndex(await this.rebuildIndex());
  }

  private async rebuildIndex(): Promise<Map<string, TaskRecord>> {
    const tasks = new Map<string, TaskRecord>();
    for (const line of (await readOptional(this.eventsPath())).split(/\r?\n/).filter(Boolean)) {
      applyTaskEvent(tasks, JSON.parse(line) as TaskEvent);
    }
    return tasks;
  }

  private async readIndex(): Promise<Map<string, TaskRecord>> {
    try {
      const records = JSON.parse(await readFile(this.indexPath(), "utf8")) as TaskRecord[];
      return new Map(records.map((task) => [task.id, task]));
    } catch {
      const rebuilt = await this.rebuildIndex();
      if (rebuilt.size > 0) {
        await this.writeIndex(rebuilt);
      }
      return rebuilt;
    }
  }

  private async writeIndex(tasks: Map<string, TaskRecord>): Promise<void> {
    const path = this.indexPath();
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify([...tasks.values()], null, 2), "utf8");
  }

  private eventsPath(): string {
    return join(this.options.projectRoot, ".tokendance", "tasks", "tasks.jsonl");
  }

  private indexPath(): string {
    return join(this.options.projectRoot, ".tokendance", "tasks", "task-index.json");
  }
}

export class TodoStore {
  constructor(private readonly options: TodoStoreOptions) {}

  async add(input: { text: string; taskId?: string }): Promise<TodoRecord> {
    const now = new Date().toISOString();
    const todos = await this.list();
    const text = input.text.trim();
    if (!text) {
      throw new Error("Todo text is required.");
    }
    const todo: TodoRecord = {
      id: `todo-${todos.length + 1}`,
      text,
      status: "pending",
      taskId: input.taskId,
      createdAt: now,
      updatedAt: now
    };
    await this.writeTodos([...todos, todo]);
    return todo;
  }

  async list(): Promise<TodoRecord[]> {
    try {
      return JSON.parse(await readFile(this.todosPath(), "utf8")) as TodoRecord[];
    } catch {
      return [];
    }
  }

  async metadata(): Promise<TodoStoreMetadata> {
    const todos = await this.list();
    return {
      projectRoot: this.options.projectRoot,
      sessionId: this.options.sessionId,
      todoCount: todos.length,
      pendingCount: todos.filter((todo) => todo.status === "pending").length,
      inProgressCount: todos.filter((todo) => todo.status === "in_progress").length,
      completedCount: todos.filter((todo) => todo.status === "completed").length,
      linkedTaskCount: todos.filter((todo) => Boolean(todo.taskId)).length
    };
  }

  async updateStatus(id: string, status: TodoStatus): Promise<TodoRecord> {
    const todos = await this.list();
    const index = todos.findIndex((todo) => todo.id === id);
    if (index < 0) {
      throw new Error(`Todo ${id} was not found.`);
    }
    const current = todos[index];
    if (!current) {
      throw new Error(`Todo ${id} was not found.`);
    }
    const updated: TodoRecord = { ...current, status, updatedAt: new Date().toISOString() };
    todos[index] = updated;
    await this.writeTodos(todos);
    return updated;
  }

  private async writeTodos(todos: TodoRecord[]): Promise<void> {
    const path = this.todosPath();
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify(todos, null, 2), "utf8");
  }

  private todosPath(): string {
    if (this.options.sessionId) {
      return join(this.options.projectRoot, ".tokendance", "sessions", this.options.sessionId, "todos.json");
    }
    return join(this.options.projectRoot, ".tokendance", "todos.json");
  }
}

function applyTaskEvent(tasks: Map<string, TaskRecord>, event: TaskEvent): void {
  if (event.type === "task.created") {
    tasks.set(event.task.id, event.task);
    return;
  }

  const task = tasks.get(event.taskId);
  if (!task) {
    return;
  }
  if (event.type === "task.status_updated") {
    tasks.set(task.id, { ...task, status: event.status, updatedAt: event.updatedAt });
    return;
  }
  if (event.type === "task.dependency_added") {
    tasks.set(task.id, {
      ...task,
      dependencies: task.dependencies.includes(event.dependencyId) ? task.dependencies : [...task.dependencies, event.dependencyId],
      updatedAt: event.updatedAt
    });
    return;
  }
  if (event.type === "task.session_linked") {
    tasks.set(task.id, { ...task, linkedSessionId: event.sessionId, updatedAt: event.updatedAt });
    return;
  }
  tasks.set(task.id, { ...task, linkedWorktree: event.worktree, updatedAt: event.updatedAt });
}

async function readOptional(path: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return "";
  }
}
