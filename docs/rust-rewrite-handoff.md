# Rust Rewrite Handoff

Last updated: 2026-06-09

## Workspace

- Repository: `TokenDanceLab/TokenDanceCode`
- Worktree: repo-local `.worktrees/rust-rewrite`
- Branch: `codex/rust-rewrite`
- Remote tracking: `origin/codex/rust-rewrite`
- Current baseline: Rust rewrite scaffold is active but not release-ready.
- Release rule: do not run `npm publish` or create a GitHub Release from this branch until the release owner explicitly approves it after package contents and registry state are checked.

## Current Git State

Last pushed commits on `codex/rust-rewrite`:

- `a3865c2 fix(rust): harden transcript sequence resume`
- `b7b6093 feat(rust): expand provider sdk and npm scaffolds`
- `5eb584e feat(rust): scaffold rewrite workspace`

Current uncommitted wave:

- `Cargo.lock`
- `Cargo.toml`
- `crates/tokendance-core/Cargo.toml`
- `crates/tokendance-core/src/provider.rs`
- `crates/tokendance-core/src/providers/openai_chat.rs`
- `crates/tokendance-core/src/runtime.rs`
- `crates/tokendance-core/src/tools/mod.rs`
- `crates/tokendance-sdk/src/lib.rs`
- `docs/release-readiness.md`
- `docs/rust-rewrite-architecture.md`
- `docs/rust-rewrite-status.md`
- `package.json`
- `scripts/check-rust-release-plan.mjs`
- `scripts/smoke-rust-wrapper-tarball.mjs` (new)

Suggested checkpoint commit after review:

```powershell
git add Cargo.toml Cargo.lock crates/tokendance-core crates/tokendance-sdk docs/release-readiness.md docs/rust-rewrite-architecture.md docs/rust-rewrite-status.md package.json scripts/check-rust-release-plan.mjs scripts/smoke-rust-wrapper-tarball.mjs docs/rust-rewrite-handoff.md
git diff --cached --check
git commit -m "feat(rust): add tool loop http and wrapper smoke"
git push
```

## What This Wave Adds

- OpenAI-compatible Chat Completions transport scaffold:
  - Default transport is disabled.
  - Enable with `TOKENDANCE_GATEWAY_HTTP_TRANSPORT=1`.
  - Reads `TOKENDANCE_GATEWAY_API_KEY` first, then `OPENAI_API_KEY`.
  - Redacts API key material in request config and tested error paths.

- Runtime tool loop scaffold:
  - Provider tool calls are executed through `ToolRegistry`.
  - Emits `tool.permission` events before execution.
  - Sends tool results into a follow-up provider call.
  - Enforces `MAX_MODEL_CALLS_PER_TURN = 2`.

- Tool catalog scaffold:
  - `read_file`
  - `write_file`
  - `run_powershell`
  - Workspace path normalization blocks absolute paths and workspace escapes.
  - Secret-like paths require approval or are denied in safe mode.
  - `run_powershell` is currently mock execution only; destructive PowerShell patterns are hard-denied before permission evaluation.

- AgentHub SDK runner parity:
  - Package info manifest.
  - Doctor/bootstrap readiness.
  - Transient context preview.
  - Existing same-session terminal failure frame behavior remains covered.

- npm wrapper smoke:
  - Adds `pnpm smoke:rust-wrapper`.
  - Script packs `packages/cli`, installs the tarball into a temp package, copies a local Rust binary into the expected optional native binary location, then runs:
    - `tokendance --version`
    - `tokendance doctor --json`
  - Scans installed wrapper package content for local paths, API-key shapes, npm/GitHub token shapes, auth token config, and private key material.

## Verification Already Run

The following commands passed in this worktree during this handoff:

```powershell
pnpm verify
pnpm release:rust:plan:check
pnpm smoke:rust-wrapper
git diff --check
node packages\cli\bin\tokendance.js --version
node packages\cli\bin\tokendance.js doctor --json
node packages\cli\bin\tokendance.js run --json "hello"
```

Observed test counts from `pnpm verify`:

- CLI: 7 tests passed.
- Core: 26 tests passed.
- SDK: 7 tests passed.

Secret/path scan over the current public Rust surface returned no matches. Re-run the repository privacy scan with the current forbidden-pattern set from `scripts/` before committing; do not paste local user paths or real token-looking strings into public docs.

```powershell
rg -n "<forbidden-secret-or-local-path-patterns>" Cargo.toml Cargo.lock crates docs package.json packages/cli/bin packages/cli/package.json scripts README.md AGENTS.md -g "*"
```

Note: `rg` exits with code 1 when there are no matches.

## Known Limits

- This is not a finished Rust rewrite.
- Real provider smoke against TokenDance Gateway is still pending.
- `run_powershell` does not execute commands yet; it classifies and returns a mock result.
- `read_file` and `write_file` are initial workspace tools, not a complete edit/patch system.
- CLI parity is still narrow: the Rust CLI has `run`, structured output, streaming JSON, and `doctor`; full TS command parity is not complete.
- Native npm package layout is scaffolded through wrapper smoke, but release packaging for platform-specific optional packages still needs a proper release-owner pass.
- Two attempted read-only subagent reviews for this wave did not complete because the subagent stream hit usage limits. Treat the local verification above as real evidence, but do not treat external review as complete.

## Next Work Queue

1. Review the current uncommitted diff manually, especially:
   - `crates/tokendance-core/src/providers/openai_chat.rs`
   - `crates/tokendance-core/src/runtime.rs`
   - `crates/tokendance-core/src/tools/mod.rs`
   - `crates/tokendance-sdk/src/lib.rs`
   - `scripts/smoke-rust-wrapper-tarball.mjs`

2. Re-run the short gate before committing:

```powershell
pnpm verify
pnpm release:rust:plan:check
pnpm smoke:rust-wrapper
git diff --check
```

3. Commit and push the wave if the review is clean.

4. Start the next parallel Rust slices with disjoint ownership:
   - CLI commands: config, gateway, auth, sessions, transcript, quality.
   - Provider smoke: OpenAI-compatible Gateway, OpenAI Responses, Anthropic Messages.
   - Tools: patch/edit tool, glob/search, shell timeout policy, command classifier coverage.
   - SDK: approval bridge wired into runtime tool execution, richer context/run parity, AgentHub consumer fixture.
   - Release: native optional package manifests, tarball privacy scan expansion, release dry-run gate.
   - Docs: README Rust rewrite status, AgentHub integration guide, release owner checklist.

## Release Readiness Rule

Before any real npm release, require all of:

```powershell
pnpm verify
pnpm release:rust:plan:check
pnpm smoke:rust-wrapper
pnpm pack:dry-run
pnpm pack:smoke
```

Then inspect package contents and registry scope manually. Publishing remains a release-owner action, not an automated script.
