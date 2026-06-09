# TokenDanceCode Agent Guide

TokenDanceCode is a local command-line Coding Agent / harness for personal developers. Keep the scope narrow and explicit: it is not a cloud platform, IDE plugin, marketplace, persistent team-agent system, or AgentHub replacement.

## Repository

- GitHub: `TokenDanceLab/TokenDanceCode`
- Public packages: `@tokendance/code-core`, `@tokendance/code-sdk`, `@tokendance/code-cli`
- Command: `tokendance`
- Runtime: Node.js 20.18+
- Package manager: pnpm 10+
- Primary shell target: Windows PowerShell

## Workspace Rules

1. This repository is independent from the TokenDance workspace root. Check and commit status inside this repository.
2. Use repository-local `.worktrees/` for isolated work. Do not create sibling worktrees outside the repo.
3. Do not commit generated state: `.env`, `.tokendance/`, `.worktrees/`, virtualenvs, build outputs, caches, logs, or local transcripts.
4. Keep public docs secret-free. Use placeholder keys such as `your-api-key`; never include real provider keys, local account details, private server paths, or production logs.
5. If the root worktree is behind `origin/master`, do not treat missing files there as lost progress. Inspect `origin/master` or create a clean worktree from it first.

## Product Boundary

TokenDanceCode focuses on:

- interactive terminal Coding Agent sessions;
- local repository reading, editing, shell execution, diff/review, task/todo, transcript, memory, resume, subagent, and worktree workflows;
- provider-neutral runtime architecture with OpenAI Responses, OpenAI Chat Completions / TokenDance Gateway, and Anthropic-compatible Messages support;
- AgentHub-consumable SDK facade, event mapping, remote approval bridge, and package manifest metadata.

Do not describe TokenDanceCode as:

- a hosted service;
- a team collaboration product;
- an AgentHub replacement;
- an IDE plugin;
- a marketplace or plugin platform;
- a production SaaS product with billing, accounts, dashboard, or cloud sync.

## Documentation Rules

- `README.md` is the public entry point: positioning, install, model configuration, commands, project structure, current maturity, and docs map.
- `docs/产品功能需求文档.md` owns product requirements and non-goals.
- `docs/架构设计文档.md` owns runtime boundaries and data flow.
- `docs/开发流程文档.md` owns implementation phases.
- `docs/端到端验收清单.md` owns manual acceptance checks.
- If behavior changes, update the smallest complete set of README plus the owning docs in the same pass.

## Verification

Use these from the repository root after code or docs changes:

```powershell
pnpm install
pnpm release:next:check
node packages/cli/dist/main.js --version
node packages/cli/dist/main.js doctor
```

Docs-only changes should still run at least the focused docs/package metadata test when practical:

```powershell
pnpm test packages/sdk/tests/package-metadata.test.ts
```

`npm publish --tag next` is a separate manual release-owner action after version, package contents, dist-tag, npm login, and license intent are reviewed. Do not put publish into verification scripts.
