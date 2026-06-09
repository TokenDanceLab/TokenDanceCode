# @tokendance/code-cli

Command line interface for TokenDanceCode.

The package installs the `tokendance` bin. It provides local coding-agent sessions, doctor/config checks, mock runs, transcript commands, memory/task helpers, AgentHub-oriented tooling, quality gates, and Windows/PowerShell-first local workflow support.

## Install

```powershell
pnpm add -g @tokendance/code-cli@next
tokendance --version
tokendance doctor
```

## Release Baseline

This package is part of the TokenDanceCode `next` prerelease train. Before publishing a prerelease tarball, run from the workspace root:

```powershell
pnpm release:next:check
pnpm pack:smoke
```

`pnpm pack:smoke` installs the packed core, SDK, and CLI tarballs into a temporary project and verifies SDK import plus CLI bin startup. Do not run `npm publish --tag next` from this check; publish is a separate manual release step after review.
