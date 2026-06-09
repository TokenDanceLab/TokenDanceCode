/**
 * Diagnostics commands: doctor, status, help, quickstart.
 */
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { TokenDanceCode, type DoctorInfo, type Thread } from "@tokendance/code-sdk";
import { heading, label, styleFromEnv, type CliStyle } from "./format.js";
import { write, readCliEnv, homeDirFor, type CliIO } from "./cli-io.js";
import { groupedTopLevelCommands } from "./commands.js";
import { groupedSlashCommands, slashCommandHelpUsages } from "./slash-commands.js";

const version = "0.2.0-ts.0";

export function getVersion(): string {
  return version;
}

// --- Doctor ---

export async function printDoctor(io: CliIO, args: string[] = []): Promise<number> {
  if (stripDoctorFormatArgs(args).length > 0) {
    await write(io.stderr, doctorUsage());
    return 1;
  }

  const doctor = await new TokenDanceCode({
    storageRoot: io.cwd(),
    env: await readCliEnv(io)
  }).doctor({ projectRoot: io.cwd(), homeDir: homeDirFor(io) });
  if (doctorFormat(args) === "json") {
    await write(io.stdout, `${JSON.stringify(doctor, null, 2)}\n`);
    return 0;
  }
  await printDoctorInfo(io, doctor);
  return 0;
}

async function printDoctorInfo(io: CliIO, doctor: DoctorInfo): Promise<void> {
  const env = await readCliEnv(io);
  const style = styleFromEnv(env);
  await write(io.stdout, `TokenDanceCode ${doctor.version}\n`);
  await writeSection(io, "Runtime", style);
  await writeField(io, "Node", doctor.node);
  await writeField(io, "cwd", doctor.cwd);
  await writeField(io, "platform", doctor.platform);
  await writeSection(io, "API Keys", style);
  await writeField(io, "api OPENAI_API_KEY", doctor.apiKeys.OPENAI_API_KEY);
  await writeField(io, "api ANTHROPIC_API_KEY", doctor.apiKeys.ANTHROPIC_API_KEY);
  await writeField(io, "api TOKENDANCE_GATEWAY_API_KEY", env.TOKENDANCE_GATEWAY_API_KEY?.trim() ? "present" : "missing");
  await writeSection(io, "Tools", style);
  await writeField(io, "git available", yesNo(doctor.git.available));
  await writeField(io, "git repository", yesNo(doctor.git.repository));
  await writeField(io, "powershell available", yesNo(doctor.powershell.available));
  await writeSection(io, "Config", style);
  await writeField(io, "project", doctor.config.projectConfigPath);
  await writeField(io, "global", doctor.config.globalConfigPath);
  await writeField(io, "sources", doctor.config.sources.join(","));
  await writeField(io, "provider", doctor.config.provider);
  await writeField(io, "model", doctor.config.model);
  await writeField(io, "provider ready", yesNo(doctor.config.validation.ready));
  await writeField(
    io,
    "provider missing",
    doctor.config.validation.missing.length > 0 ? doctor.config.validation.missing.join(", ") : "none"
  );
  await writeSection(io, "State", style);
  await writeField(io, "dir", doctor.stateDir.path);
  await writeField(io, "writable", yesNo(doctor.stateDir.writable));
}

function doctorFormat(args: string[]): "text" | "json" {
  return args.some((arg) => arg === "--json" || arg === "json") ? "json" : "text";
}

function stripDoctorFormatArgs(args: string[]): string[] {
  return args.filter((arg) => arg !== "--json" && arg !== "json");
}

function doctorUsage(): string {
  return "Usage: tokendance doctor [--json]\n";
}

function yesNo(value: boolean): "yes" | "no" {
  return value ? "yes" : "no";
}

// --- Status ---

export async function printStatus(io: CliIO, thread: Thread): Promise<void> {
  const state = thread.state;
  await writeSection(io, "Status", styleFromEnv(await readCliEnv(io)));
  await writeField(io, "sessionId", state.id);
  await writeField(io, "cwd", state.cwd);
  await writeField(io, "permissionMode", state.permissionMode);
  await writeField(io, "messages", String(state.messages.length));
}

// --- Help ---

export async function printHelp(io: CliIO): Promise<void> {
  const style = styleFromEnv(io.env?.() ?? process.env);
  const lines = [...brandBanner(style), ""];
  for (const group of groupedTopLevelCommands()) {
    lines.push(heading(`${group.category}:`, style));
    for (const command of group.commands) {
      lines.push(`  ${command.usage}`);
    }
    lines.push("");
  }
  await write(io.stdout, `${lines.join("\n").trimEnd()}\n`);
}

export function brandBanner(style: CliStyle): string[] {
  return [
    `TokenDanceCode ${version}`,
    label("TD CODE", style),
    "local coding agent | scrollback-first CLI"
  ];
}

export async function printInteractiveHelp(io: CliIO): Promise<void> {
  const style = styleFromEnv(io.env?.() ?? process.env);
  const lines = ["Commands:"];
  for (const group of groupedSlashCommands()) {
    lines.push(heading(`${group.category}:`, style));
    for (const command of group.commands) {
      for (const usage of slashCommandHelpUsages(command)) {
        lines.push(`  ${usage}`);
      }
    }
    lines.push("");
  }
  lines.push(heading("Gateway:", style));
  lines.push("  tokendance gateway init [--model model] [--base-url url]");
  await write(io.stdout, `${lines.join("\n").trimEnd()}\n`);
}

// --- Quickstart ---

export async function printQuickstart(io: CliIO): Promise<void> {
  const style = styleFromEnv(io.env?.() ?? process.env);
  await write(
    io.stdout,
    `${heading("Quickstart", style)}
1. Verify install
   tokendance --version
   tokendance doctor
2. Choose provider
   Keep mock for local smoke tests, or configure OpenAI Responses, OpenAI-compatible Chat Completions, or Anthropic-compatible Messages.
3. TokenDance Gateway preset
   tokendance gateway init --model deepseek-v4-pro
   Then set TOKENDANCE_GATEWAY_API_KEY in the current shell or ~/.tokendance/.env.
4. TokenDanceID login URL helper
   tokendance auth tokendanceid login-url --client-id agenthub-local --redirect-uri http://127.0.0.1:48731/callback
   The helper prints an authorize URL and PKCE values only; it does not exchange or store tokens.
5. Doctor and config checks
   tokendance doctor
   tokendance doctor --json
   tokendance config

Read-only: does not write env files, print secrets, open a browser, publish packages, or touch production.
`
  );
}

// --- Shared write helpers ---

export async function writeSection(io: CliIO, title: string, style: CliStyle): Promise<void> {
  await write(io.stdout, `== ${heading(title, style)} ==\n`);
}

export async function writeField(io: CliIO, name: string, value: string): Promise<void> {
  await write(io.stdout, `  ${name}: ${value}\n`);
}
