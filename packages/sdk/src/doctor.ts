import { execFile } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { readTokenDanceConfig } from "@tokendance/code-core";
import { TOKEN_DANCE_CODE_PACKAGE } from "./package-info.js";

const execFileAsync = promisify(execFile);

export type SecretStatus = "present" | "missing";

export interface DoctorOptions {
  projectRoot: string;
  homeDir?: string;
  env?: Record<string, string | undefined>;
}

export interface DoctorInfo {
  version: string;
  node: string;
  cwd: string;
  platform: NodeJS.Platform;
  apiKeys: {
    OPENAI_API_KEY: SecretStatus;
    ANTHROPIC_API_KEY: SecretStatus;
  };
  git: {
    available: boolean;
    repository: boolean;
  };
  powershell: {
    available: boolean;
  };
  config: {
    projectConfigPath: string;
    globalConfigPath: string;
    sources: Array<"defaults" | "global" | "project">;
  };
  stateDir: {
    path: string;
    writable: boolean;
  };
}

export async function collectDoctorInfo(options: DoctorOptions): Promise<DoctorInfo> {
  const env = options.env ?? process.env;
  const config = await readTokenDanceConfig({ projectRoot: options.projectRoot, homeDir: options.homeDir });
  const stateDir = join(options.projectRoot, ".tokendance");
  const gitAvailable = await commandAvailable("git", ["--version"], options.projectRoot);
  const gitRepository = gitAvailable && await commandAvailable("git", ["rev-parse", "--is-inside-work-tree"], options.projectRoot);
  const powershellAvailable = await commandAvailable("powershell.exe", ["-NoProfile", "-Command", "$PSVersionTable.PSVersion.ToString()"], options.projectRoot)
    || await commandAvailable("pwsh", ["-NoProfile", "-Command", "$PSVersionTable.PSVersion.ToString()"], options.projectRoot);

  return {
    version: TOKEN_DANCE_CODE_PACKAGE.version,
    node: process.version,
    cwd: options.projectRoot,
    platform: process.platform,
    apiKeys: {
      OPENAI_API_KEY: secretStatus(env.OPENAI_API_KEY),
      ANTHROPIC_API_KEY: secretStatus(env.ANTHROPIC_API_KEY)
    },
    git: {
      available: gitAvailable,
      repository: gitRepository
    },
    powershell: {
      available: powershellAvailable
    },
    config: {
      projectConfigPath: config.projectConfigPath,
      globalConfigPath: config.globalConfigPath,
      sources: config.sources.map((source) => source.kind)
    },
    stateDir: {
      path: stateDir,
      writable: await stateDirWritable(stateDir)
    }
  };
}

function secretStatus(value: string | undefined): SecretStatus {
  return value ? "present" : "missing";
}

async function commandAvailable(command: string, args: string[], cwd: string): Promise<boolean> {
  try {
    await execFileAsync(command, args, { cwd, timeout: 3000, windowsHide: true });
    return true;
  } catch {
    return false;
  }
}

async function stateDirWritable(stateDir: string): Promise<boolean> {
  const probe = join(stateDir, ".doctor-write-test");
  try {
    await mkdir(stateDir, { recursive: true });
    await writeFile(probe, "ok", "utf8");
    await rm(probe, { force: true });
    return true;
  } catch {
    return false;
  }
}
