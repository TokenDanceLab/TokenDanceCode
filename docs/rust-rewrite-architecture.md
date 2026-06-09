# Rust Rewrite Architecture

TokenDanceCode Rust is the active rewrite branch for the local coding-agent runtime. The TypeScript workspace remains in the tree as a contract reference until the Rust crates cover the same public behavior.

## Scope

Keep the product boundary narrow:

- local CLI coding-agent runtime;
- deterministic session and transcript storage;
- provider adapters for OpenAI Responses, OpenAI-compatible Chat Completions / TokenDance Gateway, and Anthropic-compatible Messages;
- permission modes and subject-level safety evidence;
- AgentHub-consumable SDK facade, `agent.stream` mapping, approval bridge, TokenDanceID login helper, and same-session run guard;
- Rust-first npm binary wrapper for the CLI and SDK bridge;
- MCP client for tool extensibility;
- subagent spawning for multi-agent orchestration;
- context compaction for long-running sessions;
- memory system for persistent knowledge;
- hooks system for lifecycle customization.

Do not build a hosted service, AgentHub replacement, plugin marketplace, full-screen IDE, or long-lived cloud daemon in this repo.

## Crate Map

| Crate | Role | Current baseline |
|---|---|---|
| `tokendance-core` | Runtime, provider trait, session state, permissions, transcript JSONL, config, MCP, subagent, compaction, memory, hooks, streaming, context | 185 tests, 7 built-in tools, 3 provider transports, MCP client, subagent system |
| `tokendance-sdk` | AgentHub-facing facade and event mapping | 7 tests, runner facade, schema constants, same-session guard |
| `tokendance-cli` | `tokendance` binary | 12 tests, `run`, `doctor`, `config validate`, `sessions list/show`, `transcript search`, `quality`, `gateway init`, `auth tokendanceid login-url` |

## Tool System Design

The tool system is built around `ToolDefinition`, `ToolRegistry`, and a permission-aware execution pipeline.

### ToolDefinition

Each tool declares:

- **name**: unique identifier (e.g. `echo`, `read_file`, `glob`)
- **description**: human-readable summary
- **risk**: `ToolRisk` enum (`Read`, `Write`, `Shell`, `Network`, `Dangerous`)
- **concurrency**: `ToolConcurrency` enum (`Serial`, `ParallelSafe`, `Exclusive`)
- **safety_notes**: free-text safety annotations included in permission decisions
- **subject_metadata**: describes the input field that carries the subject (e.g. `path`, `command`)
- **subject_guard**: pre-permission hook that can deny or require approval based on input content
- **executor**: the function that runs when the tool is allowed

### ToolExposure

`ToolExposure` controls whether a tool appears in the catalog for permission evaluation. Default exposure includes all registered tools.

### Subject Guards

Subject guards inspect tool input before the permission engine evaluates the tool policy. They can:

- Extract a subject string (e.g. the target file path or command)
- Block execution with `ToolSafetyEvidence` (hard-deny regardless of mode)
- Require approval for specific subjects (e.g. secret-like paths)

Two built-in guard patterns:

- **`workspace_path_subject_guard`**: normalizes and validates file paths under the session workspace. Rejects path traversal, absolute paths, and secret-like paths.
- **`directory_path_subject_guard`**: like the workspace guard but accepts directory paths (e.g. `.`). Used by `glob` and `grep` which search directories.

### Permission Engine

The `PermissionEngine` evaluates tool policies against the session's `PermissionMode`:

| Mode | Read | Write | Shell | Dangerous |
|---|---|---|---|---|
| Default | Allowed | RequiresApproval | RequiresApproval | RequiresApproval |
| Safe | Allowed | Denied | Denied | Denied |
| Auto | Allowed | Allowed | Allowed | RequiresApproval |
| Yolo | Allowed | Allowed | Allowed | Allowed |

Subject guards run before the permission engine and can override the engine (hard-deny destructive commands even in Yolo mode).

### Execution Pipeline

1. Look up `ToolDefinition` by name (fail-closed for unknown tools)
2. Run subject guard (if present) and check for hard-deny evidence
3. Run permission engine decision
4. If allowed, execute the tool function
5. Return `ToolExecutionResult` with optional `safety_evidence`

## Provider Transport Layer

Provider adapters translate session state into protocol-specific HTTP requests. The transport layer uses gated HTTP with credential redaction.

### Protocol Adapters

| Protocol | Request mapping | Key fields |
|---|---|---|
| OpenAI Responses | `input` array with `message` items and `function_call_output` for tool results | `model`, `tool_choice`, `parallel_tool_calls` |
| OpenAI Chat Completions | `messages` array with `tool` role for results | `model`, `tool_choice`, `tools` schema |
| Anthropic Messages | Split system prompt, `tool_result` content blocks | `model`, `max_tokens`, `system` |

### Credential Redaction

The `ProviderError` type redacts secret-like values in error messages:

- Values starting with `sk-` or `td-` are replaced with `[redacted]`
- Long alphanumeric strings (32+ chars) are treated as secrets
- Key-value pairs like `token=xxx` have the value redacted

HTTP transport uses `reqwest` with `rustls-tls`. API keys are resolved from `TOKENDANCE_GATEWAY_API_KEY` or per-provider env vars and are never printed to stdout or included in error context.

## MCP Client Architecture

The MCP (Model Context Protocol) client enables tool extensibility through external server processes.

### Transport

- **Protocol**: JSON-RPC 2.0 over stdio
- **Server lifecycle**: the client spawns a server process, initializes the connection, and shuts it down on drop
- **Configuration**: `McpServerConfig` defines `command`, `args`, and `env` for the server process

### Tool Discovery

- On initialization, the client calls `tools/list` to discover available tools
- Each tool is represented as `McpToolInfo` with `name`, `description`, and `inputSchema`
- Discovered tools are registered in the `ToolRegistry` with namespaced names (e.g. `mcp__{server}__{tool}`)

### Tool Execution

- Tools are called via `tools/call` with the tool name and arguments
- Results are returned as `McpToolResult` with content and error fields
- The client handles request/response correlation with JSON-RPC message IDs

### Resource Reading

- Resources are listed via `resources/list` and read via `resources/read`
- Each resource has a URI, name, description, and optional MIME type

## Subagent System

Subagents enable multi-agent orchestration by spawning isolated agent sessions.

### Configuration

`SubagentConfig` declares:

- **name**: descriptive name for the subagent type
- **prompt**: system prompt/instructions for the subagent
- **allowed_tools / disallowed_tools**: subset of parent's tools (empty means all available)
- **max_turns**: maximum turns the subagent can take (default: 10)
- **permission_mode**: can be more restrictive than parent
- **model**: optional override (None = inherit from parent)
- **working_directory**: optional override (None = inherit from parent)

### Isolation

- Each subagent gets an isolated `SessionState` with its own message history
- Tool access is filtered through the `allowed_tools`/`disallowed_tools` lists
- The subagent's permission mode can be stricter than the parent's

### Recursion Prevention

A hardcoded list of tool names (`subagent`, `run_subagent`, `agent`) are blocked from subagent tool lists to prevent unbounded recursion.

### Result

`SubagentResult` captures:

- `subagent_id`: unique identifier
- `success`: whether the subagent completed successfully
- `response`: the final response text
- `turns_completed`: number of turns executed
- `tools_used`: list of tools invoked

## Context Compaction

Context compaction reduces token usage in long-running sessions by summarizing older messages.

### Configuration

`CompactConfig` controls compaction behavior:

- **max_messages**: threshold to trigger compaction (default: 100)
- **keep_recent**: number of recent messages to preserve unsummarized (default: 10)
- **enabled**: whether compaction is active (default: true)

### Heuristic Summary

When the message count exceeds `max_messages`:

1. Messages older than `keep_recent` are selected for compaction
2. A summary is produced replacing the older messages
3. The compacted messages are removed and replaced with a single summary message
4. `CompactResult` reports the summary, messages compacted, messages kept, and estimated tokens saved

## Memory System

The memory system provides persistent knowledge storage backed by markdown files.

### Storage Format

Each memory entry is stored as a `.md` file with YAML-like frontmatter:

```markdown
---
name: user-preferences
description: User's coding preferences
metadata:
  type: feedback
  updated: "2026-06-10"
---

User prefers kebab-case for directory names...
```

### Memory Types

| Type | Scope |
|---|---|
| `user` | Global user-level preferences |
| `feedback` | User feedback and corrections |
| `project` | Project-specific knowledge |
| `reference` | Reference material and documentation |

### CRUD Operations

`MemoryStore` provides:

- **Create**: write a new memory entry as a markdown file
- **Read**: load and parse a memory entry from file
- **Update**: modify an existing memory entry in place
- **Delete**: remove a memory entry file
- **List**: enumerate all memory entries in the store

## Instruction Discovery

The context builder discovers instruction files that guide agent behavior.

### Scope Hierarchy

Instructions are loaded in order (later overrides earlier):

1. **Global**: `{HOME}/.tokendance/AGENTS.md`
2. **Project**: `{project_root}/AGENTS.md`
3. **Project (alt)**: `{project_root}/CLAUDE.md`
4. **Local**: `{project_root}/.tokendance/AGENTS.md`

### Discovery

`InstructionFile` captures:

- `path`: resolved file path
- `scope`: `InstructionScope` enum (Global, Project, Local)
- `content`: file contents

### Working Context

`WorkingContext` provides environmental context:

- `project_root`: resolved project directory
- `project_type`: detected type ("rust", "typescript", "mixed", "unknown")
- `top_level_files`: files and directories in the project root
- `instruction_count`: number of instruction files found

## Hooks System

The hooks system provides lifecycle callbacks for customizing agent behavior.

### Hook Points

| Hook | Timing | Use case |
|---|---|---|
| `PreToolUse` | Before tool execution | Validate inputs, block dangerous operations |
| `PostToolUse` | After tool execution | Audit, logging, post-processing |
| `TurnCompleted` | After a turn finishes | Progress tracking, notification |
| `TurnFailed` | After a turn fails | Error reporting, cleanup |

### Hook Context

`HookContext` provides:

- `session_id`: current session identifier
- `turn_id`: current turn identifier
- `tool_call`: tool call details (for tool hooks)
- `tool_result`: tool result (for post hooks)
- `decision`: permission decision (for tool hooks)

### Hook Results

- **Continue**: proceed normally
- **Block**: prevent the action with a reason
- **Modify**: alter the tool input (PreToolUse only)

### Registry

`HookRegistry` manages named hook collections per hook point. Hooks are registered at startup and called synchronously in registration order.

## Streaming Architecture

The streaming subsystem handles real-time output from provider responses.

### SSE Parser

`parse_sse_buffer` processes Server-Sent Events text into structured `SseEvent` objects:

- **event_type**: the SSE event type field
- **data**: concatenated data lines
- **id**: optional event ID

The parser handles SSE edge cases: comment lines (starting with `:`), concatenated data fields, and missing fields.

### StreamEvent

The streaming layer converts SSE events into `StreamEvent` variants for the runtime to process.

### Channel Integration

Provider responses flow through `tokio::sync::mpsc` channels, enabling:

- Non-blocking streaming from provider HTTP responses
- Buffered event processing in the runtime loop
- Clean shutdown when the channel closes

## Sandboxing Abstraction

The runtime provides platform-specific safety policies:

- **Windows**: PowerShell destructive-command hard-deny (e.g. `Remove-Item -Recurse -Force` on system paths)
- **Path validation**: workspace-relative path enforcement, traversal rejection
- **Secret-like paths**: paths matching common secret patterns require approval or are denied in safe mode
- **Command classification**: shell commands are classified for risk before execution

## Config System

Settings are loaded from `settings.json` files and merged:

1. **User config**: `~/.tokendance/settings.json`
2. **Project config**: `<project>/.tokendance/settings.json`
3. **Merge**: project values override user values

Settings include:

- `provider.kind`: `openai_chat_completions` | `openai_responses` | `anthropic_messages`
- `provider.model`: model identifier
- `provider.baseUrl`: custom API endpoint
- `permissionMode`: `default` | `safe` | `auto` | `yolo`
- `allowedTools` / `disallowedTools`: tool-level overrides

Validation catches unknown provider kinds, unknown permission modes, and tools appearing in both allow and disallow lists.

## Migration Order

1. Preserve TS public contracts in tests and docs.
2. Implement Rust runtime primitives: session, transcript, events, provider trait, permission profiles.
3. Port provider adapters with explicit protocol errors and no project `.env` loading.
4. Port CLI commands and structured `run --json` / `--stream-json` output.
5. Port AgentHub SDK facade: event envelope schema, approval bridge, context preview, OIDC helper, same-session concurrency.
6. Add Rust-first npm binary wrapper and SDK bridge.
7. Remove or archive TypeScript implementation only after Rust release gates prove parity.

## Parallel Work Ownership

Use repo-local worktrees under `.worktrees/` and keep ownership disjoint:

- CLI worker: `crates/tokendance-cli/**`, CLI docs/tests.
- Core runtime worker: `crates/tokendance-core/src/runtime.rs`, `transcript.rs`, runtime tests.
- Provider worker: `crates/tokendance-core/src/provider.rs`, provider adapter modules and protocol tests.
- Permission/tools worker: `permissions.rs`, tool registry and shell/file tools.
- SDK/AgentHub worker: `crates/tokendance-sdk/**`, AgentHub docs/tests.
- Release worker: npm wrapper, package metadata, privacy scan, release docs.

## Release Gate

The Rust branch is not releasable until these pass:

```powershell
cargo fmt --all -- --check
cargo test --workspace
cargo clippy --workspace -- -D warnings
cargo run -p tokendance-cli -- --version
cargo run -p tokendance-cli -- doctor --json
pnpm verify
pnpm release:rust:plan:check
pnpm smoke:rust-wrapper
node scripts/smoke-rust-release.mjs
node scripts/smoke-providers.mjs
```

`pnpm verify` intentionally remains the short Rust verification gate for now:

```powershell
cargo fmt --all -- --check && cargo test --workspace
```

## Preserved Contracts

The Rust rewrite must preserve these TS contracts before a public release:

- CLI: `tokendance run --json`, `tokendance run --stream-json`, `doctor --json`, `config validate --json`, `gateway init`, TokenDanceID login URL helper, sessions, transcript, quality, tasks/todos, worktree and subagent commands.
- Structured run JSON: aggregate result with `threadId/sessionId`, success flag, final response, events, and structured error; stream JSONL ends with `run.result`.
- AgentHub: `agenthub-sdk.v1`, `agent.stream` schema version `2`, required envelope fields, terminal `run.agent.result` for success and failure, approval request schema version `1`.
- Session safety: AgentHub `sessionId` is the TokenDanceCode thread id. Same resolved storage root plus session id must reject concurrent runs before transcript mutation.
- Provider boundary: project `.env` is ignored by default; TokenDance Gateway API keys are model API credentials and are never TokenDanceID/OIDC login tokens.
- Packaging: npm release starts with a native binary wrapper. Do not publish root workspace, private examples, legacy Python package, or Rust crates to crates.io without a separate API decision.

## Npm Wrapper Plan

The Rust-first npm binary wrapper is a distribution layer, not a second CLI implementation.

- `packages/cli/bin/tokendance.js` is the npm `bin` entry for `tokendance`.
- The JavaScript shim resolves a local built Rust binary first, then a reviewed platform-native binary package placeholder, forwards argv and stdio unchanged, and shows a clear unsupported-platform error when no binary is available.
- `packages/cli/package.json` uses Rust-aligned `build` and `test` scripts for `crates/tokendance-cli`; it no longer points the npm bin at legacy TypeScript `dist`.
- `pnpm smoke:rust-wrapper` packs and installs the wrapper locally without publishing, locates or builds the current-platform Rust binary for the temp install, runs `tokendance --version` and `tokendance doctor --json`, and scans the packed wrapper for source/test/build-only files, local paths, npm auth config, and token-like secret material.
- Platform binaries should come from CI artifacts built from `crates/tokendance-cli`; package scripts must not compile ad hoc release binaries on user machines.
- Optional native packages may be listed through `optionalDependencies` only after their manifests, CI artifact names, target triples, and smoke tests are defined.
- Planned native package names include `@tokendance/code-cli-win32-x64-msvc`, `@tokendance/code-cli-darwin-arm64`, `@tokendance/code-cli-darwin-x64`, `@tokendance/code-cli-linux-x64-gnu`, and `@tokendance/code-cli-linux-arm64-gnu`.
- Do not add publish scripts. Publishing remains a manual release-owner action from reviewed tarballs.
