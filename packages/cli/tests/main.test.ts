import { Readable, Writable } from "node:stream";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runCli, type CliIO } from "../src/main.js";

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

  it("renders runtime events for interactive tool calls", async () => {
    const io = createTestIO("echo: hello renderer\n/exit\n");

    const exitCode = await runCli([], io);
    const output = io.stdoutText();

    expect(exitCode).toBe(0);
    expect(output).toContain("tool echo started");
    expect(output).toContain("permission allowed");
    expect(output).toContain("tool echo completed");
    expect(output).toContain('Tool result: {"text":"hello renderer"}');
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
    expect(summaryLine?.length).toBeLessThanOrEqual(170);
    expect(summaryLine).toContain("... omitted ");
  });

  it("renders tool failure reasons", async () => {
    const io = createTestIO("missingtool: renderer\n/exit\n");

    const exitCode = await runCli([], io);
    const output = io.stdoutText();

    expect(exitCode).toBe(0);
    expect(output).toContain("tool missing_tool started");
    expect(output).toContain("tool missing_tool failed: Unknown tool: missing_tool");
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
