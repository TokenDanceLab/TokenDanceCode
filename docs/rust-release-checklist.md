# Rust Release Checklist

Pre-release verification checklist for TokenDanceCode Rust binary and npm wrapper.

## Pre-release Gates

- [ ] `cargo fmt --all -- --check` — formatting clean
- [ ] `cargo test --workspace` — all 204 tests pass (CLI: 12, Core: 185, SDK: 7)
- [ ] `cargo clippy --workspace -- -D warnings` — no clippy warnings
- [ ] `node scripts/check-rust-release-plan.mjs` — release plan assertions pass
- [ ] `node scripts/smoke-rust-wrapper-tarball.mjs` — npm wrapper tarball smoke passes
- [ ] `node scripts/smoke-rust-release.mjs` — comprehensive release readiness check passes
- [ ] `node scripts/smoke-providers.mjs` — provider smoke passes (if API keys available)
- [ ] Privacy scan clean — no secrets, local paths, or tokens in public files

## Package Review

- [ ] Review tarball contents: `npm pack ./packages/cli --dry-run`
- [ ] No secrets in package (no `sk-`, `tk-`, `Bearer`, private keys)
- [ ] No local paths in package (no `C:\Users`, `/home/`, internal hostnames)
- [ ] Version bumped in `crates/tokendance-cli/Cargo.toml`
- [ ] Version bumped in `packages/cli/package.json`
- [ ] Version bumped in root `package.json`
- [ ] All three versions match
- [ ] Changelog updated with version, date, and changes

## Build

- [ ] `cargo build -p tokendance-cli --release` — release build succeeds
- [ ] Binary size is reasonable (check against last release)
- [ ] Binary runs on clean machine without Rust toolchain

## Cross-Platform Build

- [ ] Windows x64 MSVC build
- [ ] macOS ARM64 build
- [ ] macOS x64 build
- [ ] Linux x64 GNU build
- [ ] Linux ARM64 GNU build

## Publish

- [ ] Create native packages for each platform
- [ ] Test install on each target platform
- [ ] `npm publish --tag next` for `@tokendance/code-cli`
- [ ] Verify on registry: `npm view @tokendance/code-cli`
- [ ] Test install from registry: `npm install -g @tokendance/code-cli@next`
- [ ] Run `tokendance --version` from registry install
- [ ] Run `tokendance doctor --json` from registry install

## Post-release

- [ ] Create Git tag: `v{version}`
- [ ] Create GitHub Release with changelog
- [ ] Update `docs/rust-rewrite-status.md` with release version
- [ ] Update `docs/rust-rewrite-handoff.md` with release commit
- [ ] Notify team of new release

## Emergency Rollback

If a published package has issues:

1. `npm deprecate @tokendance/code-cli@{version} "reason"`
2. Do not unpublish unless the package is less than 24 hours old and has zero downloads
3. Fix the issue in a new commit and publish a patch version
4. Update the release notes
