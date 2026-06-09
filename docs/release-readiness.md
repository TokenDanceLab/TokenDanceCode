# Release Readiness

Last updated: 2026-06-09 19:10 HKT.

TokenDanceCode has a local npm first-candidate commit, but the public registry does not show the packages yet. Treat this repository as ready for release review, not as published.

## Candidate

- Version: `0.2.0-ts.0`
- Packages:
  - `@tokendance/code-core`
  - `@tokendance/code-sdk`
  - `@tokendance/code-cli`

## Current Registry State

These checks still return `E404` against npmjs as of 2026-06-09 18:52 HKT:

```powershell
npm --userconfig "<npmUserConfig>" view @tokendance/code-core version dist-tags --json
npm --userconfig "<npmUserConfig>" view @tokendance/code-sdk version dist-tags --json
npm --userconfig "<npmUserConfig>" view @tokendance/code-cli version dist-tags --json
```

Registry visibility must be checked again before claiming a publish succeeded.

## Local Gates

Run from the workspace root:

```powershell
pnpm registry:next:check
pnpm contract:check
pnpm verify
pnpm pack:smoke
pnpm release:next:check
git diff --check
```

Optional real Gateway smoke, only in a controlled local shell or ignored `.config/tokendance/gateway-smoke.env`:

```powershell
pnpm smoke:gateway
```

`pnpm smoke:gateway` requires `TOKENDANCE_RUN_REAL_PROVIDER_SMOKE=1`, `TOKENDANCE_GATEWAY_API_KEY`, `TOKENDANCE_GATEWAY_BASE_URL`, and one or more model names through `TOKENDANCE_REAL_SMOKE_MODELS` or the script defaults. It does not read project `.env`, does not run `npm publish`, and redacts configured provider key and base URL values from subprocess output.

Latest known local result, to be refreshed immediately before publish:

- `pnpm release:next:check` passed on the release-candidate worktree; use the command output, not this document, as the current test-count evidence.
- `pnpm verify` passed inside that gate with TypeScript build and the current Vitest suite.
- `pnpm pack:smoke` installed real packed core, SDK, and CLI tarballs into a temporary npm project, then imported the packed SDK AgentHub consumer fixture and ran a mock AgentHub turn.
- `pnpm registry:next:check` returned `E404` for core, SDK, and CLI on npmjs; first publish can proceed after release-owner approval.
- The tarball smoke privacy scan follows pnpm scoped-package symlinks, fails if it scans zero readable package files, and checks common provider/npm/GitHub token patterns.
- `pnpm smoke:gateway` passed locally against TokenDance Gateway using configured smoke models from an ignored local `.config/` env file; no provider key or base URL was written to tracked files.

## Publish Boundary

The verification scripts must not run `npm publish`. Publishing is a separate release-owner action after package content review. Do not run `npm publish` from package source directories; source manifests intentionally keep `workspace:*` dependencies for local development. Publish only the tarballs produced by `pnpm pack`, because those tarballs rewrite workspace dependencies to concrete versions.

Before publishing:

1. Confirm npm account and org access.
2. Confirm registry is `https://registry.npmjs.org/`.
3. Run `pnpm registry:next:check`; `E404` is allowed for first publish, but the current candidate version must not already exist.
4. Run `pnpm release:next:check` on a clean worktree.
5. Review packed contents from `pnpm pack:dry-run`.
6. Create publish tarballs with `pnpm pack --pack-destination` and review each tarball path before publishing.

Tarball publish command shape:

```powershell
$tarballDir = ".tmp\npm-next-tarballs"
New-Item -ItemType Directory -Force $tarballDir | Out-Null
pnpm --filter @tokendance/code-core pack --pack-destination $tarballDir
pnpm --filter @tokendance/code-sdk pack --pack-destination $tarballDir
pnpm --filter @tokendance/code-cli pack --pack-destination $tarballDir
npm publish "<tarballPath>" --access public --tag next --userconfig "<npmUserConfig>"
```

Run `npm publish "<tarballPath>" --access public --tag next` once per reviewed tarball. Keep `<npmUserConfig>` outside this repository, do not print token-bearing config, and delete local tarballs after the publish audit is complete.

## Post-Publish Smoke

After registry visibility is confirmed:

```powershell
npm view @tokendance/code-core version dist-tags --json
npm view @tokendance/code-sdk version dist-tags --json
npm view @tokendance/code-cli version dist-tags --json
```

Then test install in a fresh temp directory:

```powershell
npm install @tokendance/code-sdk@next @tokendance/code-core@next
npm install -g @tokendance/code-cli@next
tokendance --version
tokendance doctor --json
```

Do not print npm tokens in logs or docs. Keep npm userconfig files outside this repository and do not commit their paths. Rotate any token that was exposed.
