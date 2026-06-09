# Release Readiness

Last updated: 2026-06-09 21:05 HKT.

TokenDanceCode is on the Rust rewrite branch. The current release work is scaffolding for a Rust-first npm binary wrapper and package review plan; it is not a publish-ready candidate and it must not publish npm packages from automation.

## Candidate

- Version: `0.3.0-rs.0`
- Status: release-plan scaffold only; Rust runtime parity and wrapper implementation are still required.
- Public npm entry package:
  - `@tokendance/code-cli`
- Legacy contract packages, kept only until the Rust SDK bridge decision is finished:
  - `@tokendance/code-core`
  - `@tokendance/code-sdk`

## Registry Status

Run the public registry check before claiming a publish succeeded:

```powershell
pnpm registry:next:check
```

Current result must be refreshed before any release-owner action. `E404` is acceptable before the first publish and proves the packages are not visible on npm yet.

## Local Gates

Run from the workspace root:

```powershell
pnpm verify
pnpm release:rust:plan:check
git diff --check
```

For now, `pnpm verify` intentionally stays Rust-only:

```powershell
cargo fmt --all -- --check && cargo test --workspace
```

The older pack and contract gates remain historical TypeScript-package checks until the Rust wrapper exists. Do not treat `pnpm release:next:check` as the Rust release gate yet.

`pnpm smoke:gateway` is an optional maintainer-only provider smoke. It requires explicit opt-in environment variables, never reads the project root `.env`, never runs `npm publish`, and must redact provider keys and base URLs from subprocess output.

Latest known local evidence, to be refreshed before a release decision:

- `pnpm verify` is the active Rust branch gate and runs Cargo formatting and workspace tests.
- `pnpm release:rust:plan:check` verifies the Rust wrapper plan docs, keeps `pnpm verify` on Cargo, and fails if package scripts include an npm publish command.
- The tarball smoke privacy scan is retained for the future wrapper package, but it is not the current Rust release gate.

Use fresh command output as the source for current test counts.

## Rust-First Npm Binary Wrapper Plan

The first Rust release should expose `tokendance` through `@tokendance/code-cli`. The npm package should contain a small JavaScript command shim plus metadata; the shim should select the platform-specific Rust binary and then delegate to `crates/tokendance-cli`.

Planned package shape:

- `packages/cli/bin/tokendance.js` is the cross-platform npm `bin` entry for `tokendance`.
- `packages/cli/package.json` owns public CLI metadata and the `bin` mapping.
- The CLI package may later list optional native packages in `optionalDependencies` after those packages and CI artifacts exist.
- Optional native packages should be platform scoped, for example:
  - `@tokendance/code-cli-win32-x64-msvc`
  - `@tokendance/code-cli-darwin-arm64`
  - `@tokendance/code-cli-darwin-x64`
  - `@tokendance/code-cli-linux-x64-gnu`
  - `@tokendance/code-cli-linux-arm64-gnu`

The optional native packages must contain only the compiled binary, license/readme metadata, and the minimum npm manifest needed for install resolution. They must not publish Rust crate source, local build outputs, logs, secrets, or private examples.

Before promoting the wrapper from plan to release candidate:

1. Build the Rust CLI in CI for every supported target.
2. Generate platform-native npm packages from reviewed CI artifacts.
3. Implement the JavaScript shim with clear unsupported-platform errors.
4. Add a tarball install smoke that runs `tokendance --version` and `tokendance doctor --json` from a fresh temp project.
5. Add a package privacy scan for wrapper and native package contents.
6. Run the release-owner publish checklist outside this repository.

## Publish Boundary

No package script may run `npm publish`, `pnpm publish`, or `yarn npm publish`. Publishing is a Manual release-owner action after package content review. Do not run publish commands from package source directories; source manifests may contain workspace-local development metadata until tarball contents are reviewed.

Before publishing:

1. Confirm npm account and org access.
2. Confirm registry is `https://registry.npmjs.org/`.
3. Run `pnpm registry:next:check`; `E404` is allowed for first publish, but the current candidate version must not already exist.
4. Run the current Rust release gates on a clean worktree.
5. Review packed wrapper and optional native package contents.
6. Create publish tarballs with `pnpm pack --pack-destination` and review each tarball path.
7. Release owner runs the private publish checklist from the operator secret store.

Public command shape:

```powershell
npm publish "<tarballPath>" --access public --tag next
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

Do not print npm tokens in logs or docs. Rotate any token that was exposed outside the private secret store.
