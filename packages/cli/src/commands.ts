export type TopLevelCommandCategory = "Core" | "Session" | "Work" | "Diagnostics" | "Gateway";

export interface TopLevelCommandMetadata {
  id: string;
  category: TopLevelCommandCategory;
  title: string;
  usage: string;
  aliases: readonly string[];
  json: boolean;
}

export const TOP_LEVEL_COMMAND_METADATA = [
  { id: "help", category: "Core", title: "Show command help", usage: "tokendance --help", aliases: ["--help", "-h"], json: false },
  { id: "version", category: "Core", title: "Print CLI version", usage: "tokendance --version", aliases: ["--version", "-v"], json: false },
  { id: "doctor", category: "Diagnostics", title: "Environment and AgentHub readiness diagnostics", usage: "tokendance doctor [--json]", aliases: [], json: true },
  { id: "quickstart", category: "Core", title: "Show local onboarding steps", usage: "tokendance quickstart", aliases: [], json: false },
  { id: "config", category: "Diagnostics", title: "Inspect, validate, or write local config", usage: "tokendance config [--json] [validate|set]", aliases: [], json: true },
  { id: "gateway", category: "Gateway", title: "Configure TokenDance Gateway provider preset", usage: "tokendance gateway init [--model model] [--base-url url]", aliases: [], json: false },
  { id: "auth", category: "Session", title: "Create TokenDanceID OIDC login helper output", usage: "tokendance auth tokendanceid login-url --client-id <id> --redirect-uri <uri> [--json]", aliases: [], json: true },
  { id: "resume", category: "Session", title: "Resume latest or selected session", usage: "tokendance resume [session-id]", aliases: [], json: false },
  { id: "sessions", category: "Session", title: "List recoverable sessions", usage: "tokendance sessions", aliases: [], json: false },
  { id: "memory", category: "Session", title: "Manage project or global memory", usage: "tokendance memory [add|delete] [project|global] [value]", aliases: [], json: false },
  { id: "agents", category: "Work", title: "Run, inspect, accept, or discard delegated subagents", usage: "tokendance agents [run|show|accept|discard]", aliases: [], json: false },
  { id: "diff", category: "Work", title: "Show workspace git diff", usage: "tokendance diff [path ...]", aliases: [], json: false },
  { id: "review", category: "Work", title: "Run local diff review heuristics", usage: "tokendance review", aliases: [], json: false },
  { id: "tools", category: "Work", title: "List tool metadata and permission posture", usage: "tokendance tools", aliases: [], json: false },
  { id: "quality", category: "Work", title: "Run verify/test quality gate", usage: "tokendance quality [--json] [command]", aliases: [], json: true },
  { id: "tasks", category: "Work", title: "Manage task records", usage: "tokendance tasks [create|doing|done|link-session|link-worktree] [value]", aliases: [], json: false },
  { id: "todo", category: "Work", title: "Manage todo records", usage: "tokendance todo [add|doing|done] [value]", aliases: [], json: false },
  { id: "worktree", category: "Work", title: "Manage controlled git worktrees", usage: "tokendance worktree [list|create|remove] [name] [--discard]", aliases: [], json: false },
  { id: "transcript", category: "Session", title: "Inspect or search session transcript", usage: "tokendance transcript [session-id|search <query>]", aliases: [], json: false },
  { id: "context", category: "Session", title: "Preview next-turn model context", usage: "tokendance context [--session session-id] <prompt>", aliases: [], json: false },
  { id: "compact", category: "Session", title: "Write a compact summary for a session", usage: "tokendance compact [session-id]", aliases: [], json: false },
  { id: "run", category: "Core", title: "Run a single prompt", usage: "tokendance run <prompt>", aliases: [], json: false }
] as const satisfies readonly TopLevelCommandMetadata[];

export type TopLevelCommandId = typeof TOP_LEVEL_COMMAND_METADATA[number]["id"];

export const topLevelCommandIds = TOP_LEVEL_COMMAND_METADATA.map((command) => command.id) as readonly TopLevelCommandId[];

export type TopLevelCommandResolution =
  | { kind: "handler"; id: TopLevelCommandId; args: string[] }
  | { kind: "interactive"; args: [] }
  | { kind: "unknown"; command: string; args: string[] };

export type TopLevelCommandHandler = (args: string[]) => Promise<number>;

export interface TopLevelCommandExecutor {
  handlers: Record<TopLevelCommandId, TopLevelCommandHandler>;
  interactive: () => Promise<number>;
  unknown: (command: string, args: string[]) => Promise<number>;
}

const topLevelCommands = new Set<string>(topLevelCommandIds);
const topLevelAliases = new Map<string, TopLevelCommandId>(
  TOP_LEVEL_COMMAND_METADATA.flatMap((command) => command.aliases.map((alias) => [alias, command.id as TopLevelCommandId]))
);

export function groupedTopLevelCommands(): Array<{ category: TopLevelCommandCategory; commands: TopLevelCommandMetadata[] }> {
  const categories: TopLevelCommandCategory[] = ["Core", "Session", "Work", "Diagnostics", "Gateway"];
  return categories.map((category) => ({
    category,
    commands: TOP_LEVEL_COMMAND_METADATA.filter((command) => command.category === category)
  }));
}

export function resolveTopLevelCommand(argv: string[]): TopLevelCommandResolution {
  const [command, ...args] = argv;
  if (!command) {
    return { kind: "interactive", args: [] };
  }

  const alias = topLevelAliases.get(command);
  if (alias) {
    return { kind: "handler", id: alias, args };
  }

  if (topLevelCommands.has(command)) {
    return { kind: "handler", id: command as TopLevelCommandId, args };
  }

  return { kind: "unknown", command, args };
}

export function runTopLevelCommand(argv: string[], executor: TopLevelCommandExecutor): Promise<number> {
  const route = resolveTopLevelCommand(argv);
  if (route.kind === "interactive") {
    return executor.interactive();
  }
  if (route.kind === "unknown") {
    return executor.unknown(route.command, route.args);
  }
  return executor.handlers[route.id](route.args);
}
