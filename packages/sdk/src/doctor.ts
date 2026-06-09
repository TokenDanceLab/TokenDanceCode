import { execFile } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { readTokenDanceConfig, validateProviderConfig, type ProviderConfigValidation } from "@tokendance/code-core";
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
  packageInfo: typeof TOKEN_DANCE_CODE_PACKAGE;
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
    sources: Array<"defaults" | "global" | "project" | "env">;
    provider: string;
    model: string;
    validation: ProviderConfigValidation;
  };
  stateDir: {
    path: string;
    writable: boolean;
  };
  startup: {
    hub: StartupCheckGroup;
    edge: StartupCheckGroup;
  };
  agentHub: AgentHubDoctorReadiness;
}

export type StartupCheckStatus = "pass" | "warn" | "fail";

export interface StartupCheck {
  name: string;
  status: StartupCheckStatus;
  message: string;
}

export interface StartupCheckGroup {
  ok: boolean;
  checks: StartupCheck[];
}

export interface AgentHubDoctorReadiness {
  contractVersion: typeof TOKEN_DANCE_CODE_PACKAGE.agentHub.sdkContractVersion;
  agentStreamSchemaVersion: typeof TOKEN_DANCE_CODE_PACKAGE.agentHub.agentStreamSchemaVersion;
  features: typeof TOKEN_DANCE_CODE_PACKAGE.agentHub.features;
  ready: boolean;
  blockingChecks: string[];
  warningChecks: string[];
}

export async function collectDoctorInfo(options: DoctorOptions): Promise<DoctorInfo> {
  const env = options.env ?? process.env;
  const config = await readTokenDanceConfig({ projectRoot: options.projectRoot, homeDir: options.homeDir, env });
  const validation = validateProviderConfig(config.config, env);
  const stateDir = join(options.projectRoot, ".tokendance");
  const gitAvailable = await commandAvailable("git", ["--version"], options.projectRoot);
  const gitRepository = gitAvailable && await commandAvailable("git", ["rev-parse", "--is-inside-work-tree"], options.projectRoot);
  const powershellAvailable = await commandAvailable("powershell.exe", ["-NoProfile", "-Command", "$PSVersionTable.PSVersion.ToString()"], options.projectRoot)
    || await commandAvailable("pwsh", ["-NoProfile", "-Command", "$PSVersionTable.PSVersion.ToString()"], options.projectRoot);
  const stateWritable = await stateDirWritable(stateDir);
  const startup = startupChecks({
    stateWritable,
    gitAvailable,
    powershellAvailable,
    validation
  });

  return {
    version: TOKEN_DANCE_CODE_PACKAGE.version,
    packageInfo: TOKEN_DANCE_CODE_PACKAGE,
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
      sources: config.sources.map((source) => source.kind),
      provider: config.config.provider,
      model: config.config.model,
      validation
    },
    stateDir: {
      path: stateDir,
      writable: stateWritable
    },
    startup,
    agentHub: agentHubReadiness(startup)
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

function startupChecks(input: {
  stateWritable: boolean;
  gitAvailable: boolean;
  powershellAvailable: boolean;
  validation: ProviderConfigValidation;
}): DoctorInfo["startup"] {
  const hubChecks: StartupCheck[] = [
    {
      name: "package-info",
      status: "pass",
      message: `${TOKEN_DANCE_CODE_PACKAGE.packages.sdk.name} ${TOKEN_DANCE_CODE_PACKAGE.version}`
    },
    {
      name: "config-readable",
      status: "pass",
      message: "TokenDanceCode config facade is readable"
    },
    {
      name: "state-dir-writable",
      status: input.stateWritable ? "pass" : "fail",
      message: input.stateWritable ? ".tokendance state directory is writable" : ".tokendance state directory is not writable"
    },
    {
      name: "provider-ready",
      status: input.validation.ready ? "pass" : "warn",
      message: providerReadyMessage(input.validation)
    }
  ];
  const edgeChecks: StartupCheck[] = [
    {
      name: "agent-stream-envelope",
      status: "pass",
      message: `AgentHub agent.stream schema v${TOKEN_DANCE_CODE_PACKAGE.agentHub.agentStreamSchemaVersion}`
    },
    {
      name: "git-available",
      status: input.gitAvailable ? "pass" : "warn",
      message: input.gitAvailable ? "git is available" : "git is not available; repo tools will be limited"
    },
    {
      name: "powershell-available",
      status: input.powershellAvailable ? "pass" : "warn",
      message: input.powershellAvailable ? "PowerShell is available" : "PowerShell is not available; shell tools will be limited"
    }
  ];

  return {
    hub: {
      ok: hubChecks.every((check) => check.status !== "fail"),
      checks: hubChecks
    },
    edge: {
      ok: edgeChecks.every((check) => check.status !== "fail"),
      checks: edgeChecks
    }
  };
}

function providerReadyMessage(validation: ProviderConfigValidation): string {
  if (validation.ready) {
    return `provider ${validation.provider} is ready`;
  }
  return `provider ${validation.provider} missing ${validation.missing.join(", ")}`;
}

function agentHubReadiness(startup: DoctorInfo["startup"]): AgentHubDoctorReadiness {
  return {
    contractVersion: TOKEN_DANCE_CODE_PACKAGE.agentHub.sdkContractVersion,
    agentStreamSchemaVersion: TOKEN_DANCE_CODE_PACKAGE.agentHub.agentStreamSchemaVersion,
    features: TOKEN_DANCE_CODE_PACKAGE.agentHub.features,
    ready: startup.hub.ok && startup.edge.ok,
    blockingChecks: collectStartupChecks(startup, "fail"),
    warningChecks: collectStartupChecks(startup, "warn")
  };
}

function collectStartupChecks(startup: DoctorInfo["startup"], status: StartupCheckStatus): string[] {
  return [
    ...startup.hub.checks.filter((check) => check.status === status).map((check) => `hub.${check.name}`),
    ...startup.edge.checks.filter((check) => check.status === status).map((check) => `edge.${check.name}`)
  ];
}
