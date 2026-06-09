import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createDefaultToolRegistry, ToolOrchestrator, type SessionState } from "../src/index.js";

describe("run_powershell tool", () => {
  it("exposes auditable risk and permission metadata", () => {
    const metadata = createDefaultToolRegistry().metadata().find((tool) => tool.name === "run_powershell");

    expect(metadata).toMatchObject({
      risk: "shell",
      riskSummary: "Shell tool: executes local commands and is approval-gated outside yolo mode.",
      permission: {
        default: "requires_approval",
        safe: "denied",
        auto: "allowed",
        yolo: "allowed"
      },
      permissionReasons: {
        default: "mode=default tool=run_powershell risk=shell action=approval_required: default mode requires approval before running shell tools; concurrency=exclusive; safety=PowerShell classifier hard-denies destructive commands before execution."
      },
      safetyNotes: ["PowerShell classifier hard-denies destructive commands before execution."]
    });
  });

  it("executes safe commands in the workspace under yolo mode", async () => {
    const root = await mkdtemp(join(tmpdir(), "tdcode-shell-"));
    await writeFile(join(root, "hello.txt"), "hello", "utf8");
    const orchestrator = new ToolOrchestrator(createDefaultToolRegistry());

    const result = await orchestrator.execute(
      { id: "shell-1", name: "run_powershell", input: { command: "Get-ChildItem -Name", timeout: 5 } },
      createSession(root, "yolo")
    );

    expect(result.ok).toBe(true);
    expect(result.output).toMatchObject({ exitCode: 0, timedOut: false });
    expect(JSON.stringify(result.output)).toContain("hello.txt");
  });

  it("denies dangerous commands before execution even in yolo mode", async () => {
    const root = await mkdtemp(join(tmpdir(), "tdcode-shell-"));
    const orchestrator = new ToolOrchestrator(createDefaultToolRegistry());

    const result = await orchestrator.execute(
      { id: "shell-danger", name: "run_powershell", input: { command: "git reset --hard" } },
      createSession(root, "yolo")
    );

    expect(result).toMatchObject({
      ok: false,
      error: "Tool execution denied by PowerShell risk classifier: command matches blocked pattern 'git reset --hard' with evidence 'git reset --hard'",
      safetyEvidence: {
        source: "powershell_classifier",
        status: "denied",
        reason: "command matches blocked pattern 'git reset --hard' with evidence 'git reset --hard'",
        evidence: {
          rule: "git reset --hard",
          matched: "git reset --hard",
          commandPreview: "git reset --hard"
        }
      }
    });
  });

  it("uses the dangerous command guard for quality gate override commands", async () => {
    const root = await mkdtemp(join(tmpdir(), "tdcode-shell-"));
    const orchestrator = new ToolOrchestrator(createDefaultToolRegistry());

    const result = await orchestrator.execute(
      { id: "quality-danger", name: "quality_gate", input: { command: "git reset --hard", timeout: 5 } },
      createSession(root, "yolo")
    );

    expect(result).toMatchObject({
      ok: false,
      error: "Tool execution denied by PowerShell risk classifier: command matches blocked pattern 'git reset --hard' with evidence 'git reset --hard'",
      safetyEvidence: {
        toolName: "quality_gate",
        source: "powershell_classifier",
        status: "denied"
      }
    });
  });

  it("requires approval in default mode through the permission engine", async () => {
    const root = await mkdtemp(join(tmpdir(), "tdcode-shell-"));
    const orchestrator = new ToolOrchestrator(createDefaultToolRegistry());

    const result = await orchestrator.execute(
      { id: "shell-default", name: "run_powershell", input: { command: "Get-ChildItem -Name" } },
      createSession(root, "default")
    );

    expect(result).toMatchObject({
      ok: false,
      error: "mode=default tool=run_powershell risk=shell action=approval_required: default mode requires approval before running shell tools; concurrency=exclusive; safety=PowerShell classifier hard-denies destructive commands before execution.",
      safetyEvidence: {
        source: "permission_engine",
        status: "requires_approval",
        decision: expect.objectContaining({
          riskMetadata: expect.objectContaining({
            mode: "default",
            toolName: "run_powershell",
            toolRisk: "shell",
            action: "approval_required"
          })
        })
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
