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
| Core runtime scaffold | Done | mock provider one-turn runtime, transcript JSONL, TS-style event names, transcript seq continuation |
| CLI scaffold | Done | `tokendance --version`, `doctor --json`, `run --json`, `run --stream-json` |
| SDK scaffold | Done | AgentHub schema constants, `agent.stream` frame mapping, same-session rejection terminal frame |
| Provider scaffold | Done | TS-aligned protocols, typed provider errors, OpenAI Responses / Chat / Anthropic request mapping skeletons |
| Tool catalog scaffold | Done | permission profile metadata, echo tool, fail-closed unknown tools, denied execution safety evidence |
| File and shell tool scaffold | Done | read/write workspace path tools, secret-like path evidence, PowerShell destructive-command hard deny |
| Runtime tool-loop scaffold | Done | provider tool calls, permission events, tool execution, follow-up provider call, model-call limit |
| SDK bridge scaffold | Done | TokenDanceID PKCE login helper, callback state validation, approval pending/decide snapshots |
| SDK runner parity scaffold | Done | package info, doctor, bootstrap, transient context preview |
| Npm wrapper scaffold | Done | `packages/cli/bin/tokendance.js` forwards to the Rust binary and release-plan check asserts wrapper boundaries |
| Npm wrapper smoke | Done | local tarball pack/install, wrapper binary smoke, package privacy scan |
| Rust release plan | Done | `scripts/check-rust-release-plan.mjs`, Rust-first npm binary wrapper plan |

## Verified Gates

```powershell
pnpm verify
pnpm release:rust:plan:check
cargo run -p tokendance-cli -- --version
cargo run -p tokendance-cli -- doctor --json
cargo run -p tokendance-cli -- run --json "hello"
cargo run -p tokendance-cli -- run --stream-json "hello"
```

Current Rust test coverage:

- CLI: 7 tests
- Core: 26 tests
- SDK: 7 tests

## Completed Parallel Slices

| Slice | Target | Ownership |
|---|---|---|
| Provider adapters | typed provider protocols, protocol errors, OpenAI Responses / Chat / Anthropic mapping skeletons | `crates/tokendance-core/src/provider.rs`, `crates/tokendance-core/src/providers/**` |
| Tools and permissions | tool catalog metadata, permission profiles, echo execution, safety evidence | `crates/tokendance-core/src/permissions.rs`, `crates/tokendance-core/src/tools/**` |
| SDK bridge | AgentHub approval bridge and TokenDanceID OIDC helper | `crates/tokendance-sdk/**` |
| Npm wrapper | JS binary shim and release-plan checks | `packages/cli/**`, `scripts/**`, release docs |
| Real provider HTTP | gated OpenAI-compatible Chat / TokenDance Gateway transport without printing credentials |
| File/shell tools | read/write scaffolds, PowerShell classifier, path subjects |
| Runtime tool loop | provider tool calls, permission events, tool results, model-call limit |
| SDK runner parity | context preview, bootstrap, doctor/packageInfo facades |
| Package smoke | local tarball install of wrapper plus current-platform binary |

## Next Parallel Slices

| Slice | Target |
|---|---|
| Real provider smoke | gated smoke against TokenDance Gateway/OpenAI-compatible endpoint without committing credentials or printing key material |
| CLI parity | top-level command coverage beyond `run`/`doctor`, including config/gateway/auth/session/transcript/quality stubs and usage errors |
| Runtime safety | richer permission subjects, shell timeout policy, file edit/patch tools, and PowerShell classifier coverage |
| SDK runtime wiring | approval bridge wired through runtime tool execution, AgentHub context/run parity tests, terminal failure frame hardening |
| Release packaging | current-platform native package placeholder, wrapper tarball install in `release:next:check`, expanded privacy scan |

Future parallel slices must keep file ownership disjoint until the coordinator integrates them.

## Release Boundary

This branch is not ready for npm or GitHub Release publication. The next release candidate requires real provider smoke, richer file/shell/patch tools, approval bridge runtime wiring, npm native-package packaging, expanded tarball privacy scans, and full CLI/SDK contract parity tests.
