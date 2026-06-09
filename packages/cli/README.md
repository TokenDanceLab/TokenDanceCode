# @tokendance/code-cli

Command line interface for TokenDanceCode.

The package installs the `tokendance` bin. It provides local coding-agent sessions, doctor/config checks, mock runs, transcript commands, memory/task helpers, AgentHub-oriented tooling, quality gates, and Windows/PowerShell-first local workflow support.

## Command Architecture

`packages/cli/src/main.ts` is the thin CLI entry point for the `tokendance` bin. Keep argv parsing and top-level command dispatch in `packages/cli/src/commands.ts`; `main.ts` should wire IO-aware handlers such as `doctor`, `config`, `run`, `quality`, transcript, worktree, task, and auth commands without changing their JSON, usage, or text output shapes.

## Install

The `next` tag may not be public while release review is in progress. Use workspace source or packed tarballs until `npm view @tokendance/code-cli dist-tags --json` confirms registry visibility. After that:

```powershell
pnpm add -g @tokendance/code-cli@next
tokendance --version
tokendance doctor
tokendance config --json
tokendance config validate --json
tokendance config set provider openai-chat-completions model <model-name> permission-mode safe
tokendance config set --json provider openai-chat-completions model <model-name> permission-mode safe
tokendance quality --json
```

`tokendance config --json` prints the same structured payload as the SDK config facade for scripts and AgentHub shells. `tokendance config validate` checks current provider readiness without printing secrets and returns non-zero when required env/model values are missing. `tokendance config set` writes only safe JSON config fields (`provider`, `model`, `permissionMode`) and refuses API keys, tokens, and other secret-like fields; `--json` also returns `scope` and `savedPath`. Put provider keys in environment variables or the global `~/.tokendance/.env` instead.

`tokendance doctor` accepts only text output or `--json`; unknown flags return usage before diagnostics run. `tokendance quality --json [command]` returns the quality gate result as `{ passed, result: { stdout, stderr, exitCode } }` for scripts, while `tokendance quality [command]` keeps the human-readable output.

Interactive turns use a scrollback-first renderer instead of a full-screen TUI. Tool lifecycle, permission, error, and token usage lines keep stable plain-text badges such as `[tool]`, `[permission]`, `[error]`, and `[usage]`; ANSI color only highlights those same tokens when color is enabled, so `NO_COLOR` and test captures remain deterministic. Tool events include compact command/path/output summaries, text output is collapsed to one scrollback line with character and line counts, and failures render as small reason/evidence blocks for copy-paste debugging.

Help output stays command-palette inspired but plain: commands are grouped by workflow (`Core`, `Session`, `Work`, `Diagnostics`, `Gateway`) and remain printable text. Do not add OpenTUI/full-screen widgets, cursor-managed panes, or renderer behavior that depends on terminal state beyond optional ANSI color.

## Release Baseline

This package is part of the TokenDanceCode `next` prerelease train. Before publishing a prerelease tarball, run from the workspace root:

```powershell
pnpm contract:check
pnpm release:next:check
pnpm pack:smoke
```

`pnpm contract:check` is a read-only release drift gate for package manifests, AgentHub contract readiness, and the pack smoke entrypoint. `pnpm pack:smoke` installs the packed core, SDK, and CLI tarballs into a temporary project and verifies SDK import, a mock turn, CLI startup, `doctor --json` AgentHub readiness, and `quality --json` structured output. Do not run `npm publish --tag next` from these checks; publish is a separate manual release step after review.

Manual approval gate: this package-local README must stay aligned with the root README before any `npm publish --tag next` action. Release owner review should confirm the `tokendance` bin starts from the packed tarball and that CLI docs describe local use, doctor/config readiness, and AgentHub-friendly diagnostics without promising a hosted service.
