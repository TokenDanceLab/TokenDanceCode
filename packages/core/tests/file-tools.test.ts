import { mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createDefaultToolRegistry, ToolOrchestrator, type SessionState } from "../src/index.js";

describe("file tools", () => {
  it("reads and writes UTF-8 files inside the workspace", async () => {
    const root = await mkdtemp(join(tmpdir(), "tdcode-files-"));
    const orchestrator = new ToolOrchestrator(createDefaultToolRegistry());
    const session = createSession(root, "yolo");

    const writeResult = await orchestrator.execute(
      { id: "write-1", name: "write_file", input: { path: "notes/hello.txt", content: "hello 中文" } },
      session
    );
    const readResult = await orchestrator.execute(
      { id: "read-1", name: "read_file", input: { path: "notes/hello.txt" } },
      session
    );

    expect(writeResult).toMatchObject({ ok: true, output: { path: "notes/hello.txt" } });
    expect(readResult).toMatchObject({ ok: true, output: { content: "hello 中文" } });
  });

  it("replaces exact text once", async () => {
    const root = await mkdtemp(join(tmpdir(), "tdcode-files-"));
    await writeFile(join(root, "notes.txt"), "old value\nold value\n", "utf8");
    const orchestrator = new ToolOrchestrator(createDefaultToolRegistry());

    const result = await orchestrator.execute(
      { id: "edit-1", name: "edit_file", input: { path: "notes.txt", old_text: "old value", new_text: "new value" } },
      createSession(root, "yolo")
    );

    expect(result).toMatchObject({ ok: true, output: { replacements: 1 } });
    await expect(readFile(join(root, "notes.txt"), "utf8")).resolves.toBe("new value\nold value\n");
  });

  it("rejects paths outside the workspace", async () => {
    const root = await mkdtemp(join(tmpdir(), "tdcode-files-"));
    const orchestrator = new ToolOrchestrator(createDefaultToolRegistry());

    const result = await orchestrator.execute(
      { id: "read-outside", name: "read_file", input: { path: "../outside.txt" } },
      createSession(root, "yolo")
    );

    expect(result).toMatchObject({ ok: false, error: "Path is outside the workspace" });
  });

  it("requires approval before reading .env files even in yolo mode", async () => {
    const root = await mkdtemp(join(tmpdir(), "tdcode-files-"));
    await writeFile(join(root, ".env"), "TOKEN=secret", "utf8");
    const orchestrator = new ToolOrchestrator(createDefaultToolRegistry());

    const result = await orchestrator.execute(
      { id: "read-env", name: "read_file", input: { path: ".env" } },
      createSession(root, "yolo")
    );

    expect(result).toMatchObject({
      ok: false,
      error: "mode=yolo tool=read_file risk=read action=approval_required subject=path:.env: secret-like path requires approval before access",
      safetyEvidence: {
        source: "permission_engine",
        status: "requires_approval"
      }
    });
  });

  it("requires approval before writing secret-like paths even in yolo mode", async () => {
    const root = await mkdtemp(join(tmpdir(), "tdcode-files-"));
    const orchestrator = new ToolOrchestrator(createDefaultToolRegistry());

    const result = await orchestrator.execute(
      { id: "write-secret", name: "write_file", input: { path: "config/production.secret", content: "secret" } },
      createSession(root, "yolo")
    );

    expect(result).toMatchObject({
      ok: false,
      error: "mode=yolo tool=write_file risk=write action=approval_required subject=path:config/production.secret: secret-like path requires approval before access",
      safetyEvidence: {
        source: "permission_engine",
        status: "requires_approval"
      }
    });
  });

  it("denies paths that escape the workspace through a symlink target when the platform exposes realpath", async () => {
    const root = await mkdtemp(join(tmpdir(), "tdcode-files-"));
    const outside = await mkdtemp(join(tmpdir(), "tdcode-outside-"));
    await writeFile(join(outside, "outside.txt"), "outside", "utf8");
    try {
      await symlink(outside, join(root, "linked"), "junction");
    } catch {
      return;
    }
    const orchestrator = new ToolOrchestrator(createDefaultToolRegistry());

    const result = await orchestrator.execute(
      { id: "read-linked-outside", name: "read_file", input: { path: "linked/outside.txt" } },
      createSession(root, "yolo")
    );

    expect(result).toMatchObject({
      ok: false,
      error: "mode=yolo tool=read_file risk=read action=denied subject=path:linked/outside.txt: resolved path escapes the workspace",
      safetyEvidence: {
        source: "permission_engine",
        status: "denied"
      }
    });
  });

  it("reports missing files with a stable error", async () => {
    const root = await mkdtemp(join(tmpdir(), "tdcode-files-"));
    const orchestrator = new ToolOrchestrator(createDefaultToolRegistry());

    const result = await orchestrator.execute(
      { id: "missing", name: "read_file", input: { path: "missing.txt" } },
      createSession(root, "yolo")
    );

    expect(result).toMatchObject({ ok: false, error: "File not found: missing.txt" });
  });

  it("leaves files unchanged when edit text is missing", async () => {
    const root = await mkdtemp(join(tmpdir(), "tdcode-files-"));
    const filePath = join(root, "notes.txt");
    await writeFile(filePath, "existing text\n", "utf8");
    const orchestrator = new ToolOrchestrator(createDefaultToolRegistry());

    const result = await orchestrator.execute(
      { id: "edit-missing", name: "edit_file", input: { path: "notes.txt", old_text: "absent", new_text: "new" } },
      createSession(root, "yolo")
    );

    expect(result).toMatchObject({ ok: false, error: "oldText was not found" });
    await expect(readFile(filePath, "utf8")).resolves.toBe("existing text\n");
  });

  it("glob returns relative matches and excludes internal or sensitive paths", async () => {
    const root = await mkdtemp(join(tmpdir(), "tdcode-files-"));
    await writeFile(join(root, "src.ts"), "", "utf8");
    await writeFile(join(root, "README.md"), "", "utf8");
    await writeFile(join(root, ".env"), "SECRET=value", "utf8");
    await mkdir(join(root, "src"), { recursive: true });
    await writeFile(join(root, "src", ".env"), "SECRET=value", "utf8");
    await writeFile(join(root, "node_modules.tmp"), "", "utf8");
    const orchestrator = new ToolOrchestrator(createDefaultToolRegistry());
    for (const internalDir of [
      ".git/objects",
      ".tokendance/sessions",
      ".pytest_cache",
      ".mypy_cache",
      ".ruff_cache",
      ".venv",
      "__pycache__",
      "build",
      "dist",
      "node_modules/pkg",
      "venv"
    ]) {
      await mkdir(join(root, internalDir), { recursive: true });
      await writeFile(join(root, internalDir, "hidden.ts"), "", "utf8");
    }

    const result = await orchestrator.execute(
      { id: "glob-1", name: "glob", input: { pattern: "**/*" } },
      createSession(root, "yolo")
    );

    expect(result).toMatchObject({ ok: true, output: { matches: ["README.md", "node_modules.tmp", "src.ts"] } });
  });

  it("declares risk levels for permission enforcement", () => {
    const specs = Object.fromEntries(createDefaultToolRegistry().list().map((tool) => [tool.name, tool.risk]));

    expect(specs).toMatchObject({
      read_file: "read",
      glob: "read",
      write_file: "write",
      edit_file: "write"
    });
  });

  it("write tools are not allowed in default mode without approval handling", async () => {
    const root = await mkdtemp(join(tmpdir(), "tdcode-files-"));
    const orchestrator = new ToolOrchestrator(createDefaultToolRegistry());

    const result = await orchestrator.execute(
      { id: "write-1", name: "write_file", input: { path: "notes.txt", content: "hello" } },
      createSession(root, "default")
    );

    expect(result).toMatchObject({
      ok: false,
      error: "mode=default tool=write_file risk=write action=approval_required: default mode requires approval before running write tools",
      safetyEvidence: {
        source: "permission_engine",
        status: "requires_approval"
      }
    });
  });
});

function createSession(cwd: string, permissionMode: SessionState["permissionMode"]): SessionState {
  return {
    id: "test-session",
    cwd,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    permissionMode,
    messages: []
  };
}
