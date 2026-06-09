# Release Readiness

Last updated: 2026-06-09 17:02 HKT.

TokenDanceCode has a local npm first-candidate commit, but the public registry does not show the packages yet. Treat this repository as ready for release review, not as published.

## Candidate

- Branch: `codex/ts-refactor`
- Candidate pointer: `release/npm-first`
- Candidate commit: `8af8ab1f1440bcee742cedf663549eabbd336e1a`
- Version: `0.2.0-ts.0`
- Packages:
  - `@tokendance/code-core`
  - `@tokendance/code-sdk`
  - `@tokendance/code-cli`

## Current Registry State

These checks still return `E404` against npmjs as of 2026-06-09 17:02 HKT:

```powershell
npm --userconfig "<npmUserConfig>" view @tokendance/code-core version dist-tags --json
npm --userconfig "<npmUserConfig>" view @tokendance/code-sdk version dist-tags --json
npm --userconfig "<npmUserConfig>" view @tokendance/code-cli version dist-tags --json
```

Registry visibility must be checked again before claiming a publish succeeded.

## Local Gates

Run from the workspace root:

```powershell
pnpm contract:check
pnpm verify
pnpm pack:smoke
pnpm release:next:check
git diff --check
```

Latest known local result:

- `pnpm release:next:check` passed.
- `pnpm verify` passed inside that gate with TypeScript build and Vitest `26` files / `242` tests.
- `pnpm pack:smoke` installed real packed core, SDK, and CLI tarballs into a temporary project.
- The tarball smoke privacy scan follows pnpm scoped-package symlinks and fails if it scans zero readable package files.

## Publish Boundary

The verification scripts must not run `npm publish`. Publishing is a separate release-owner action after package content review.

Before publishing:

1. Confirm npm account and org access.
2. Confirm registry is `https://registry.npmjs.org/`.
3. Confirm each package name is still unavailable or intentionally being overwritten by a new version.
4. Run `pnpm release:next:check` on a clean worktree.
5. Review packed contents from `pnpm pack:dry-run`.

Publish command shape:

```powershell
npm --userconfig "<npmUserConfig>" publish --access public --tag next
```

Run it from each package directory only after checking the package manifest and tarball contents for that package.

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

Do not print npm tokens in logs or docs. Keep the npm userconfig path in the operator secret store, not in public project docs. Rotate any token that was exposed outside the local secret store.
