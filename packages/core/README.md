# @tokendance/code-core

Core runtime package for TokenDanceCode.

This package owns session state, runtime events, tool orchestration, permission decisions, transcript storage, memory/task helpers, worktree helpers, and provider adapters. It is published so the SDK and CLI can share the same runtime contract; most applications should consume `@tokendance/code-sdk` instead of importing core internals directly.

## Install

```powershell
pnpm add @tokendance/code-core@next
```

## Release Baseline

This package is part of the TokenDanceCode `next` prerelease train. Before publishing a prerelease tarball, run from the workspace root:

```powershell
pnpm release:next:check
pnpm pack:smoke
```

`pnpm pack:smoke` installs the packed core, SDK, and CLI tarballs into a temporary project and verifies SDK import plus CLI bin startup. Do not run `npm publish --tag next` from this check; publish is a separate manual release step after review.

Manual approval gate: this package-local README must stay aligned with the root README before any `npm publish --tag next` action. Release owner review should confirm the core package remains a shared runtime dependency for the SDK and CLI, not the preferred AgentHub application integration surface.
