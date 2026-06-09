# Release Readiness

Last updated: 2026-06-09 20:52 HKT.

TokenDanceCode has a local npm first-candidate baseline. The public registry does not show the packages yet, so the correct public status is release-review ready, not published.

## Candidate

- Version: `0.2.0-ts.0`
- Candidate branch: `release/npm-first`
- Source of truth: the pushed `release/npm-first` branch tip after the latest local gate run.
- Packages:
  - `@tokendance/code-core`
  - `@tokendance/code-sdk`
  - `@tokendance/code-cli`

## Registry Status

Run the public registry check before claiming a publish succeeded:

```powershell
pnpm registry:next:check
```

Current result: the three public packages still return npm `E404`, which is acceptable before the first publish and proves the packages are not visible on npm yet.

## Local Gates

Run from the workspace root:

```powershell
pnpm registry:next:check
pnpm contract:check
pnpm verify
pnpm pack:smoke
pnpm release:next:check
pnpm release:publish:check
git diff --check
```

`pnpm smoke:gateway` is an optional maintainer-only provider smoke. It requires explicit opt-in environment variables, never reads the project root `.env`, never runs `npm publish`, and must redact provider keys and base URLs from subprocess output.

Latest known local evidence, to be refreshed immediately before publish:

- `pnpm wave7:status -- --json` passed with all six Wave 7 worktrees clean.
- `pnpm release:next:check` passed on the release-candidate baseline.
- `pnpm verify` passed inside that gate with TypeScript build and Vitest `26` files / `301` tests passing.
- `pnpm pack:smoke` installed real packed core, SDK, and CLI tarballs into a temporary npm project, imported the packed SDK AgentHub consumer fixture, and ran a mock AgentHub turn.
- `pnpm registry:next:check` reported npm `E404` for core, SDK, and CLI.
- `pnpm release:publish:check` is the final local preflight before a human publish: it requires a clean worktree, requires `HEAD` to match local and remote `release/npm-first`, reruns registry/contract/verify/build/pack gates, stages reviewed tarballs under `.tmp/release-publish/<version>-<commit>`, smoke-tests those exact tarballs, prints SHA-256 hashes, and prints explicit publish commands with `--registry https://registry.npmjs.org/`.
- `git diff --check` passed after README/docs cleanup.
- The tarball smoke privacy scan follows pnpm scoped-package symlinks, fails if it scans zero readable package files, and checks common provider, npm, GitHub token, local path, and private-key patterns.

Use fresh command output as the source for current test counts.

## Publish Boundary

Verification scripts must not run `npm publish`. Publishing is a separate release-owner action after package content review. Do not run `npm publish` from package source directories; source manifests intentionally keep `workspace:*` dependencies for local development. Publish only the tarballs produced by `pnpm pack`, because those tarballs rewrite workspace dependencies to concrete versions.

Before publishing:

1. Confirm npm account and org access.
2. Confirm registry is `https://registry.npmjs.org/`.
3. Run `pnpm registry:next:check`; `E404` is allowed for first publish, but the current candidate version must not already exist.
4. Run `pnpm release:publish:check` on a clean worktree.
5. Review packed contents from `pnpm pack:dry-run`.
6. Publish only the staged tarball paths printed by `pnpm release:publish:check`; verify their SHA-256 hashes before publishing.
7. Release owner completes the external npm credential and 2FA checklist outside this repository.

Public command shape:

```powershell
npm publish "<tarballPath>" --access public --tag next --registry https://registry.npmjs.org/
```

Run the publish command once per reviewed tarball. Keep token-bearing npm configuration outside this repository and out of logs.

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

Do not print npm tokens in logs or docs. Rotate any token that was exposed outside approved credential storage.
