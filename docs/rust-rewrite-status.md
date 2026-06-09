# Rust Rewrite Status

This document records public, secret-free progress for the Rust rewrite branch.

## Branch

- Branch: `codex/rust-rewrite`
- Worktree: repo-local `.worktrees/rust-rewrite`
- Base: TypeScript refactor branch after the AgentHub same-session concurrency fixes.
- First Rust scaffold commit: `5eb584e feat(rust): scaffold rewrite workspace`

## Current Baseline

| Area | Status | Evidence |
|---|---|---|
| Cargo workspace | Done | `crates/tokendance-core`, `crates/tokendance-sdk`, `crates/tokendance-cli` |
| Core runtime | Done | mock provider one-turn runtime, transcript JSONL, TS-style event names, transcript seq continuation |
| CLI | Done | `tokendance --version`, `doctor --json`, `run --json`, `run --stream-json`, `config validate --json`, `sessions list/show`, `transcript search`, `quality` |
| SDK | Done | AgentHub schema constants, `agent.stream` frame mapping, same-session rejection terminal frame |
| Provider adapters | Done | OpenAI Responses, OpenAI Chat Completions, Anthropic Messages; typed protocol errors; credential redaction |
| Tool catalog | Done | 7 built-in tools: echo, read_file, write_file, edit_file, glob, grep, run_powershell; permission profiles; subject guards |
| File/shell tools | Done | workspace path normalization, secret-like path evidence, PowerShell destructive-command hard deny |
| Runtime tool loop | Done | provider tool calls, permission events, tool execution, follow-up provider call, model-call limit |
| SDK bridge | Done | TokenDanceID PKCE login helper, callback state validation, approval pending/decide snapshots |
| SDK runner parity | Done | package info, doctor, bootstrap, transient context preview |
| Npm wrapper | Done | `packages/cli/bin/tokendance.js` forwards to Rust binary; release-plan check asserts wrapper boundaries |
| Npm wrapper smoke | Done | local tarball pack/install, wrapper binary smoke, package privacy scan |
| Rust release plan | Done | `scripts/check-rust-release-plan.mjs`, Rust-first npm binary wrapper plan |
| Config loading | Done | user/project settings merge, validation, permission mode resolution |
| CLI command parity | Done | `config validate`, `sessions list/show`, `transcript search`, `quality` implemented |
| MCP client | Done | stdio JSON-RPC client, tool discovery, resource reading, namespaced tool registration |
| Subagent spawning | Done | isolated session, filtered tools, recursion prevention, configurable max turns |
| Context compaction | Done | threshold-based compaction, heuristic summary, configurable limits |
| Memory system | Done | markdown files with frontmatter, CRUD operations, scoped memory types |
| Instruction discovery | Done | AGENTS.md/CLAUDE.md detection, scope hierarchy (global/project/local) |
| Hooks system | Done | PreToolUse/PostToolUse/TurnCompleted/TurnFailed hooks |
| Streaming | Done | SSE parser, StreamEvent type, mpsc channel integration |
| Context builder | Done | working context detection, project type inference, instruction file discovery |
| Session resume | Done | transcript-based session restore and continuation |
| Provider smoke | Done | opt-in smoke test via `scripts/smoke-providers.mjs` |
| Release readiness | Done | comprehensive gate via `scripts/smoke-rust-release.mjs` |

## Verified Gates

```powershell
pnpm verify
pnpm release:rust:plan:check
cargo run -p tokendance-cli -- --version
cargo run -p tokendance-cli -- doctor --json
cargo run -p tokendance-cli -- run --json "hello"
cargo run -p tokendance-cli -- run --stream-json "hello"
cargo run -p tokendance-cli -- config validate --json
cargo run -p tokendance-cli -- sessions list
cargo run -p tokendance-cli -- quality
node scripts/smoke-rust-release.mjs
```

Current Rust test coverage (204 total):

- CLI: 12 tests
- Core: 185 tests
- SDK: 7 tests

## Completed Phases

### Phase 1 — Scaffold

| Slice | Target | Ownership |
|---|---|---|
| Cargo workspace | workspace structure, 3 crates | `Cargo.toml`, `crates/**` |
| Core runtime scaffold | mock provider, transcript JSONL, TS-style events | `crates/tokendance-core/src/runtime.rs` |
| CLI scaffold | `--version`, `doctor --json`, `run --json`, `run --stream-json` | `crates/tokendance-cli/src/main.rs` |
| SDK scaffold | AgentHub schema constants, event mapping | `crates/tokendance-sdk/src/lib.rs` |

### Phase 2 — Tools, Providers, Config

| Slice | Target | Ownership |
|---|---|---|
| Provider adapters | typed provider protocols, protocol errors, OpenAI/Anthropic mapping | `crates/tokendance-core/src/provider.rs`, `crates/tokendance-core/src/providers/**` |
| Tools and permissions | tool catalog, permission profiles, echo, safety evidence | `crates/tokendance-core/src/permissions.rs`, `crates/tokendance-core/src/tools/**` |
| File/shell tools | read/write/edit, glob, grep, PowerShell classifier, path subjects | `crates/tokendance-core/src/tools/mod.rs` |
| Config system | settings load/merge/validate, permission mode resolution | `crates/tokendance-core/src/config.rs` |
| CLI commands | config validate, sessions list/show, transcript search, quality | `crates/tokendance-cli/src/main.rs` |

### Phase 3 — Streaming, REPL, Memory, Hooks

| Slice | Target | Ownership |
|---|---|---|
| Streaming | SSE parser, StreamEvent type, mpsc channel | `crates/tokendance-core/src/streaming.rs` |
| Context builder | working context detection, instruction file discovery | `crates/tokendance-core/src/context.rs` |
| Memory system | markdown files with frontmatter, CRUD, scoped types | `crates/tokendance-core/src/memory.rs` |
| Hooks system | PreToolUse/PostToolUse/TurnCompleted/TurnFailed | `crates/tokendance-core/src/hooks.rs` |
| Session resume | transcript-based restore and continuation | `crates/tokendance-core/src/transcript.rs` |

### Phase 4 — MCP, Subagent, Compaction

| Slice | Target | Ownership |
|---|---|---|
| MCP client | stdio JSON-RPC, tool discovery, resource reading, namespacing | `crates/tokendance-core/src/mcp.rs` |
| Subagent spawning | isolated session, filtered tools, recursion prevention | `crates/tokendance-core/src/subagent.rs` |
| Context compaction | threshold-based, heuristic summary, configurable limits | `crates/tokendance-core/src/compact.rs` |
| SDK runner parity | package info, doctor, bootstrap, context preview | `crates/tokendance-sdk/src/lib.rs` |
| Npm wrapper | JS binary shim, release-plan checks, tarball smoke | `packages/cli/**`, `scripts/**` |
| Provider smoke | opt-in gated HTTP transport smoke | `scripts/smoke-providers.mjs` |
| Release readiness | comprehensive gate script | `scripts/smoke-rust-release.mjs` |

## Release Boundary

This branch is ready for pre-release review. The next release candidate requires:

- Manual release-owner review of package contents
- All `scripts/smoke-rust-release.mjs` gates passing
- Privacy scan clean on all public files
- Version bumped in `Cargo.toml` and `package.json`
- Changelog updated

See [docs/rust-release-checklist.md](rust-release-checklist.md) for the full checklist.
