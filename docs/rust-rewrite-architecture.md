# Rust Rewrite Architecture

TokenDanceCode Rust is the active rewrite branch for the local coding-agent runtime. The TypeScript workspace remains in the tree as a contract reference until the Rust crates cover the same public behavior.

## Scope

Keep the product boundary narrow:

- local CLI coding-agent runtime;
- deterministic session and transcript storage;
- provider adapters for OpenAI Responses, OpenAI-compatible Chat Completions / TokenDance Gateway, and Anthropic-compatible Messages;
- permission modes and subject-level safety evidence;
- AgentHub-consumable SDK facade, `agent.stream` mapping, approval bridge, TokenDanceID login helper, and same-session run guard;
- Rust-first npm binary wrapper for the CLI and SDK bridge.

Do not build a hosted service, AgentHub replacement, plugin marketplace, full-screen IDE, or long-lived cloud daemon in this repo.

## Crate Map

| Crate | Role | Current baseline |
|---|---|---|
| `tokendance-core` | Runtime, provider trait, session state, permissions, transcript JSONL | Mock provider and one-turn transcript loop compile and test |
| `tokendance-sdk` | AgentHub-facing facade and event mapping | Runner facade, schema constants, same-session in-process guard |
| `tokendance-cli` | `tokendance` binary | `run`, `doctor`, `config validate`, `gateway init`, `auth tokendanceid login-url`, session/transcript/quality stubs |

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
cargo run -p tokendance-cli -- --version
cargo run -p tokendance-cli -- doctor --json
cargo run -p tokendance-cli -- run --json "hello"
pnpm verify
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

- `packages/cli/bin/tokendance.js` should become the npm `bin` entry for `tokendance`.
- The JavaScript shim should resolve a reviewed platform-native binary package, forward argv and stdio unchanged, and show a clear unsupported-platform error when no binary is installed.
- Platform binaries should come from CI artifacts built from `crates/tokendance-cli`; package scripts must not compile ad hoc release binaries on user machines.
- Optional native packages may be listed through `optionalDependencies` only after their manifests, CI artifact names, target triples, and smoke tests are defined.
- Planned native package names include `@tokendance/code-cli-win32-x64-msvc`, `@tokendance/code-cli-darwin-arm64`, `@tokendance/code-cli-darwin-x64`, `@tokendance/code-cli-linux-x64-gnu`, and `@tokendance/code-cli-linux-arm64-gnu`.
- Do not add publish scripts. Publishing remains a manual release-owner action from reviewed tarballs.

## Next Parallel Slices

| Slice | Owner paths | First deliverable |
|---|---|---|
| CLI contract | `crates/tokendance-cli/**`, CLI tests | parser and JSON/JSONL tests for `run`, `doctor`, config/gateway/auth stubs |
| Runtime contract | `crates/tokendance-core/**` | event enum parity, transcript sequence continuity, permission subjects |
| Provider adapters | `crates/tokendance-core/src/provider*` | typed protocol errors and mock/openai-chat scaffold |
| AgentHub SDK | `crates/tokendance-sdk/**` | schema v2 envelopes, approval bridge scaffold, same-session terminal failure |
| Release wrapper | `package.json`, `scripts/**`, package metadata docs | binary npm wrapper plan, privacy scan updates, no publish script |
