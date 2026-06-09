export type SlashCommandCategory = "Session" | "Work" | "Diagnostics" | "Exit";

export interface SlashCommandMetadata {
  id: string;
  category: SlashCommandCategory;
  title: string;
  usage: string;
  helpUsages?: readonly string[];
  aliases: readonly string[];
  json: boolean;
}

export const SLASH_COMMAND_METADATA = [
  { id: "help", category: "Session", title: "Show interactive command help", usage: "/help", aliases: [], json: false },
  { id: "new", category: "Session", title: "Start a fresh session", usage: "/new", aliases: [], json: false },
  { id: "status", category: "Session", title: "Show current session status", usage: "/status", aliases: [], json: false },
  { id: "quickstart", category: "Session", title: "Show local onboarding steps", usage: "/quickstart", aliases: [], json: false },
  { id: "permissions", category: "Session", title: "Inspect or change permission mode", usage: "/permissions [default|safe|auto|yolo]", aliases: [], json: false },
  { id: "resume", category: "Session", title: "Resume latest session", usage: "/resume", aliases: [], json: false },
  { id: "sessions", category: "Session", title: "List recoverable sessions", usage: "/sessions", aliases: [], json: false },
  { id: "memory", category: "Session", title: "Manage project or global memory", usage: "/memory [add|delete] [project|global] [value]", aliases: [], json: false },
  {
    id: "auth",
    category: "Session",
    title: "Create TokenDanceID OIDC login helper output",
    usage: "/auth tokendanceid login-url --client-id <id> --redirect-uri <uri> [--json]",
    aliases: [],
    json: true
  },
  { id: "transcript", category: "Session", title: "Inspect or search session transcript", usage: "/transcript [search <query>]", aliases: [], json: false },
  { id: "context", category: "Session", title: "Preview next-turn model context", usage: "/context <prompt>", aliases: [], json: false },
  { id: "compact", category: "Session", title: "Write a compact summary for a session", usage: "/compact", aliases: [], json: false },
  {
    id: "agents",
    category: "Work",
    title: "Run, inspect, accept, or discard delegated subagents",
    usage: "/agents [run|show|accept|discard]",
    helpUsages: [
      "/agents [run investigator|reviewer <prompt>]",
      "/agents run coding [--worktree name] <prompt>",
      "/agents show <agent-id>",
      "/agents accept <agent-id> [--discard-worktree] [--allow-dirty-target]",
      "/agents discard <agent-id> [--discard]"
    ],
    aliases: [],
    json: false
  },
  { id: "tasks", category: "Work", title: "Manage task records", usage: "/tasks [create|doing|done|link-session|link-worktree] [value]", aliases: [], json: false },
  { id: "todo", category: "Work", title: "Manage todo records", usage: "/todo [add|doing|done] [value]", aliases: [], json: false },
  { id: "worktree", category: "Work", title: "Manage controlled git worktrees", usage: "/worktree [list|create|remove] [name] [--discard]", aliases: [], json: false },
  { id: "diff", category: "Work", title: "Show workspace git diff", usage: "/diff [path ...]", aliases: [], json: false },
  { id: "review", category: "Work", title: "Run local diff review heuristics", usage: "/review", aliases: [], json: false },
  { id: "tools", category: "Work", title: "List tool metadata and permission posture", usage: "/tools", aliases: [], json: false },
  { id: "quality", category: "Work", title: "Run verify/test quality gate", usage: "/quality [json] [command]", aliases: [], json: true },
  { id: "doctor", category: "Diagnostics", title: "Environment and AgentHub readiness diagnostics", usage: "/doctor [json]", aliases: [], json: true },
  {
    id: "config",
    category: "Diagnostics",
    title: "Inspect, validate, or write local config",
    usage: "/config [json]",
    helpUsages: [
      "/config [json]",
      "/config validate [json]",
      "/config set [json] [--project|--global] provider <provider> model <model> permission-mode <mode>"
    ],
    aliases: [],
    json: true
  },
  { id: "exit", category: "Exit", title: "Exit the interactive session", usage: "/exit", aliases: ["/quit"], json: false }
] as const satisfies readonly SlashCommandMetadata[];

export type SlashCommandId = typeof SLASH_COMMAND_METADATA[number]["id"];

export const slashCommandIds = SLASH_COMMAND_METADATA.map((command) => command.id) as readonly SlashCommandId[];

const slashCommandCategories: SlashCommandCategory[] = ["Session", "Work", "Diagnostics", "Exit"];

export function groupedSlashCommands(): Array<{ category: SlashCommandCategory; commands: SlashCommandMetadata[] }> {
  return slashCommandCategories.map((category) => ({
    category,
    commands: SLASH_COMMAND_METADATA.filter((command) => command.category === category)
  }));
}

export function slashCommandUsage(id: SlashCommandId): string {
  return SLASH_COMMAND_METADATA.find((command) => command.id === id)?.usage ?? `/${id}`;
}

export function slashCommandHelpUsages(command: SlashCommandMetadata): readonly string[] {
  return [...new Set([command.usage, ...(command.helpUsages ?? [])])];
}
