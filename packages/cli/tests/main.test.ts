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
