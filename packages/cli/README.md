# @tokendance/code-cli

Command line interface for TokenDanceCode.

The package installs the `tokendance` bin. It provides local coding-agent sessions, doctor/config checks, mock runs, transcript commands, memory/task helpers, AgentHub-oriented tooling, quality gates, and Windows/PowerShell-first local workflow support.

## Install

```powershell
pnpm add -g @tokendance/code-cli@next
tokendance --version
tokendance doctor
tokendance config --json
tokendance config validate --json
tokendance config set provider openai-chat-completions model deepseek-v4-pro permission-mode safe
tokendance config set --json provider openai-chat-completions model deepseek-v4-pro permission-mode safe
tokendance quality --json
```

`tokendance config --json` prints the same structured payload as the SDK config facade for scripts and AgentHub shells. `tokendance config validate` checks current provider readiness without printing secrets and returns non-zero when required env/model values are missing. `tokendance config set` writes only safe JSON config fields (`provider`, `model`, `permissionMode`) and refuses API keys, tokens, and other secret-like fields; `--json` also returns `scope` and `savedPath`. Put provider keys in environment variables or the global `~/.tokendance/.env` instead.

`tokendance doctor` accepts only text output or `--json`; unknown flags return usage before diagnostics run. `tokendance quality --json [command]` returns the quality gate result as `{ passed, result: { stdout, stderr, exitCode } }` for scripts, while `tokendance quality [command]` keeps the human-readable output.

## Release Baseline

This package is part of the TokenDanceCode `next` prerelease train. Before publishing a prerelease tarball, run from the workspace root:

```powershell
pnpm release:next:check
pnpm pack:smoke
```

`pnpm pack:smoke` installs the packed core, SDK, and CLI tarballs into a temporary project and verifies SDK import plus CLI bin startup. Do not run `npm publish --tag next` from this check; publish is a separate manual release step after review.
