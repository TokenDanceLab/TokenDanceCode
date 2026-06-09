# Rust Rewrite Handoff

Last updated: 2026-06-10

## Workspace

- Repository: `TokenDanceLab/TokenDanceCode`
- Worktree: repo-local `.worktrees/rust-rewrite`
- Branch: `codex/rust-rewrite`
- Remote tracking: `origin/codex/rust-rewrite`
- Current baseline: Rust rewrite all 4 phases complete. 204 tests passing.
- Release rule: do not run `npm publish` or create a GitHub Release from this branch until the release owner explicitly approves it after package contents and registry state are checked.

## Current Git State

Last pushed commits on `codex/rust-rewrite`:

```
c1389b5 feat(rust): Phase 4 — MCP client, subagent spawning, context compaction
9ce9228 feat(rust): Phase 3 — streaming, REPL, context builder, memory, hooks, session resume
e7b9db2 feat(rust): Phase 2 — tools, providers, config, CLI commands
c75f001 feat(rust): add tool loop, HTTP transport, wrapper smoke, SDK runner parity
a3865c2 fix(rust): harden transcript sequence resume
b7b6093 feat(rust): expand provider sdk and npm scaffolds
5eb584e feat(rust): scaffold rewrite workspace
```

## What Is Implemented

### Phase 1 — Scaffold

- Cargo workspace with 3 crates: `tokendance-core`, `tokendance-sdk`, `tokendance-cli`
- Mock provider one-turn runtime, transcript JSONL, TS-style event names
- CLI: `--version`, `doctor --json`, `run --json`, `run --stream-json`
- SDK: AgentHub schema constants, `agent.stream` frame mapping, same-session rejection

### Phase 2 — Tools, Providers, Config

- 3 provider transports: OpenAI Responses, OpenAI Chat Completions, Anthropic Messages
- 7 built-in tools: echo, read_file, write_file, edit_file, glob, grep, run_powershell
- Permission engine with Default/Safe/Auto/Yolo modes
- Subject guards: workspace path, directory path, PowerShell destructive-command deny
- Config system: user/project settings merge, validation
- CLI commands: config validate, sessions list/show, transcript search, quality

### Phase 3 — Streaming, REPL, Memory, Hooks

- SSE parser and StreamEvent types
- Context builder with instruction file discovery (AGENTS.md/CLAUDE.md)
- Memory system: markdown files with frontmatter, CRUD operations, scoped types
- Hooks: PreToolUse, PostToolUse, TurnCompleted, TurnFailed
- Session resume via transcript restore

### Phase 4 — MCP, Subagent, Compaction

- MCP client: stdio JSON-RPC, tool discovery, resource reading, namespaced tools
- Subagent spawning: isolated session, filtered tools, recursion prevention
- Context compaction: threshold-based, heuristic summary
- Provider smoke script (`scripts/smoke-providers.mjs`)
- Release readiness script (`scripts/smoke-rust-release.mjs`)

### Test Coverage

- CLI: 12 tests
- Core: 185 tests
- SDK: 7 tests
- **Total: 204 tests**

## What Remains

- `run_powershell` does not execute commands yet; it classifies and returns a mock result
- `read_file` and `write_file` are initial workspace tools; a complete edit/patch system is still needed
- Real provider smoke against TokenDance Gateway requires API keys (opt-in script exists)
- Native npm package layout is scaffolded; platform-specific optional packages need a release-owner pass
- Full CLI/SDK contract parity with TypeScript implementation
- AgentHub consumer integration tests
- Release packaging for all target platforms

## Verification Commands

```powershell
# Short gate
pnpm verify

# Release plan check
pnpm release:rust:plan:check

# Wrapper smoke
pnpm smoke:rust-wrapper

# Full release readiness
node scripts/smoke-rust-release.mjs

# Provider smoke (opt-in, requires API keys)
TOKENDANCE_SMOKE_PROVIDERS=1 TOKENDANCE_GATEWAY_HTTP_TRANSPORT=1 node scripts/smoke-providers.mjs

# Individual checks
cargo run -p tokendance-cli -- --version
cargo run -p tokendance-cli -- doctor --json
cargo run -p tokendance-cli -- run --json "hello"
cargo run -p tokendance-cli -- config validate --json
cargo run -p tokendance-cli -- sessions list
cargo run -p tokendance-cli -- quality
```

## Suggested Commit

```powershell
git add scripts/smoke-providers.mjs scripts/smoke-rust-release.mjs docs/rust-rewrite-status.md docs/rust-rewrite-architecture.md docs/rust-rewrite-handoff.md docs/rust-release-checklist.md README.md
git diff --cached --check
git commit -m "feat(rust): provider smoke, release readiness, documentation update"
```

## Release Readiness Rule

Before any real npm release, require all of:

```powershell
node scripts/smoke-rust-release.mjs
pnpm release:rust:plan:check
pnpm smoke:rust-wrapper
```

Then inspect package contents and registry scope manually. Publishing remains a release-owner action, not an automated script. See [docs/rust-release-checklist.md](rust-release-checklist.md) for the full checklist.
