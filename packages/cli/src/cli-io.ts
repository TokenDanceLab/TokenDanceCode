/**
 * CLI IO primitives: stream types, write helpers, env reading, home directory.
 */
import { join } from "node:path";
import { readFile } from "node:fs/promises";
import type { Readable, Writable } from "node:stream";

export interface CliIO {
  stdin: Readable;
  stdout: Writable;
  stderr: Writable;
  cwd: () => string;
  homeDir?: () => string;
  env?: () => Record<string, string | undefined>;
}

export function write(stream: Writable, text: string): Promise<void> {
  return new Promise((resolve, reject) => {
    stream.write(text, (error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

export function homeDirFor(io: CliIO): string {
  return io.homeDir?.() ?? process.env.USERPROFILE ?? process.env.HOME ?? io.cwd();
}

export function defaultIO(): CliIO {
  return {
    stdin: process.stdin,
    stdout: process.stdout,
    stderr: process.stderr,
    cwd: () => process.cwd(),
    homeDir: () => process.env.USERPROFILE ?? process.env.HOME ?? process.cwd(),
    env: () => process.env
  };
}

export async function readCliEnv(io: CliIO): Promise<Record<string, string | undefined>> {
  return {
    ...(await readGlobalEnvFile(homeDirFor(io))),
    ...(io.env?.() ?? process.env)
  };
}

export async function readGlobalEnvFile(homeDir: string): Promise<Record<string, string>> {
  try {
    return parseEnvFile(await readFile(join(homeDir, ".tokendance", ".env"), "utf8"));
  } catch {
    return {};
  }
}

export function parseEnvFile(content: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }
    const separatorIndex = line.indexOf("=");
    if (separatorIndex <= 0) {
      continue;
    }
    const key = line.slice(0, separatorIndex).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      continue;
    }
    env[key] = unquoteEnvValue(line.slice(separatorIndex + 1).trim());
  }
  return env;
}

function unquoteEnvValue(value: string): string {
  if ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  return value;
}

export function isEntrypoint(): boolean {
  const argvPath = process.argv[1];
  return argvPath !== undefined && process.argv[1] !== undefined && import.meta.url.endsWith(fileURLBasename(argvPath));
}

function fileURLBasename(path: string): string {
  const sep = path.includes("/") ? "/" : "\\";
  return path.split(sep).pop() ?? "";
}
