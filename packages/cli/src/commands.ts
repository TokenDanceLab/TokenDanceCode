const topLevelCommandIds = [
  "help",
  "version",
  "doctor",
  "quickstart",
  "config",
  "gateway",
  "auth",
  "resume",
  "sessions",
  "memory",
  "agents",
  "diff",
  "review",
  "tools",
  "quality",
  "tasks",
  "todo",
  "worktree",
  "transcript",
  "context",
  "compact",
  "run"
] as const;

export type TopLevelCommandId = typeof topLevelCommandIds[number];

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
const topLevelAliases = new Map<string, TopLevelCommandId>([
  ["--help", "help"],
  ["-h", "help"],
  ["--version", "version"],
  ["-v", "version"]
]);

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
