# TokenDanceCode

> Local command-line coding agent for personal repositories. Windows and PowerShell first. Embeddable through the AgentHub SDK surface.

[中文](README.md) · [AgentHub SDK](docs/agenthub-sdk.md) · [Release readiness](docs/release-readiness.md) · [TS roadmap](docs/TS重构路线图.md)

![Screenshot: TokenDanceCode CLI terminal session](docs/images/image-01.png)

The screenshot shows `tokendance` running as a local CLI inside PowerShell.

## What It Is

TokenDanceCode is a local CLI agent. Run `tokendance` inside a repository to read code, edit files, run guarded PowerShell tools, inspect Git diffs, manage tasks, and save every turn to a JSONL transcript.

The current codebase is a TypeScript monorepo. It borrows the useful parts of Claude Code, Codex CLI, and OpenCode: a thin CLI, a public SDK, structured runtime events, transcripts, provider adapters, a permission pipeline, and testable release gates.

TokenDanceCode focuses on the local coding-agent runtime and the SDK surface AgentHub can call. AgentHub owns team workflows, product orchestration, and multi-agent collaboration.

## Status

| Area | Status | Notes |
|---|---|---|
| CLI | Usable | `tokendance`, `run`, `doctor`, `config`, `resume`, `quality`, `transcript` |
| Runtime | Usable | session state, event stream, tools, permissions, JSONL transcript |
| Provider adapters | Usable | OpenAI Responses, OpenAI Chat Completions / TokenDance Gateway, Anthropic-compatible Messages |
| TokenDance Gateway | Usable | OpenAI-compatible Chat Completions adapter; TokenDance API keys stay separate from TokenDanceID login tokens |
| AgentHub SDK | Usable | thread run/context, event sink, approval bridge, doctor/config, task/todo/subagent/worktree facade |
| Subagent / worktree | Early usable | Intended for isolated code-change tasks, not a resident team system |
| npm release | Preparing `next` | Release gates are documented; rerun `pnpm release:next:check` before publishing. Registry status is tracked in [Release readiness](docs/release-readiness.md) |

Planned public packages:

- `@tokendance/code-core`
- `@tokendance/code-sdk`
- `@tokendance/code-cli`

`@tokendance/code-agenthub-example` remains a private workspace example package.

## Common Commands

```powershell
tokendance
tokendance run "summarize this repo"
tokendance doctor --json
tokendance config validate --json
tokendance gateway init --model <model-name>
tokendance auth tokendanceid login-url --client-id agenthub-local --redirect-uri http://127.0.0.1:48731/callback --json
tokendance sessions
tokendance transcript search "needle"
tokendance quality "pnpm verify"
```

## Quick Start

```powershell
git clone https://github.com/TokenDanceLab/TokenDanceCode.git
cd TokenDanceCode
pnpm install
pnpm verify
pnpm --filter @tokendance/code-cli build
node packages/cli/dist/main.js --version
node packages/cli/dist/main.js quickstart
node packages/cli/dist/main.js doctor
node packages/cli/dist/main.js run "hello"
```

Without API keys, the CLI uses MockProvider. That is enough for install checks, SDK smoke tests, transcripts, and package smoke tests.

## Provider Boundary

TokenDanceCode does not read the project root `.env` by default. Pass provider keys through SDK `env`, a controlled shell, or the global TokenDance env file.

| Provider | API key | Base URL |
|---|---|---|
| `openai-responses` | `OPENAI_API_KEY` | `OPENAI_BASE_URL`, default `https://api.openai.com/v1` |
| `openai-chat-completions` | `TOKENDANCE_GATEWAY_API_KEY`, fallback `OPENAI_API_KEY` | Gateway key uses `TOKENDANCE_GATEWAY_BASE_URL`; OpenAI fallback uses `OPENAI_BASE_URL` |
| `anthropic-messages` | `ANTHROPIC_API_KEY` | `ANTHROPIC_BASE_URL`, default `https://api.anthropic.com` |

TokenDance Gateway model calls use TokenDance API keys. TokenDanceID/OIDC tokens belong to the identity/session plane and must not be used as model API keys.

## AgentHub SDK

AgentHub should consume `@tokendance/code-sdk`.

```ts
import { TOKEN_DANCE_CODE_PACKAGE, TokenDanceCode } from "@tokendance/code-sdk";

console.log(TOKEN_DANCE_CODE_PACKAGE.agentHub.features);

const client = new TokenDanceCode({
  storageRoot: "<agenthubProject>/.tokendance-code",
  env: process.env
});

const thread = client.startThread({
  workingDirectory: "<agenthubProject>",
  permissionMode: "default"
});

const turn = await thread.run("summarize this repo");
console.log(turn.finalResponse);
```

The SDK exposes thread runs, streamed events, context preview, AgentHub event sinks, remote approval bridging, doctor/config readiness, transcript helpers, task/todo/subagent/worktree facades, and a TokenDanceID OIDC Authorization Code + PKCE login URL helper.

## Packages

```text
packages/
  core/               runtime, providers, tools, permissions, transcript
  sdk/                public SDK for AgentHub and local scripts
  cli/                tokendance command and scrollback renderer
  agenthub-example/   private AgentHub integration example
```

The old Python `src/tokendance` and `tests/` directories are kept as v0.1 migration references. New work on this branch goes into the TypeScript packages.

## Development

```powershell
pnpm typecheck
pnpm test
pnpm verify
pnpm contract:check
pnpm pack:smoke
pnpm release:next:check
```

Do not run `npm publish --tag next` from verification scripts. Publishing is a manual release-owner action after package content, registry state, and npm login are checked.

## Docs

| Document | Purpose |
|---|---|
| [docs/agenthub-sdk.md](docs/agenthub-sdk.md) | SDK and AgentHub integration |
| [docs/release-readiness.md](docs/release-readiness.md) | npm first candidate and registry checks |
| [docs/TS重构路线图.md](docs/TS重构路线图.md) | TS refactor roadmap |
| [docs/架构对标评估.md](docs/架构对标评估.md) | Claude Code / Codex / OpenCode comparison |
| [docs/端到端验收清单.md](docs/端到端验收清单.md) | Windows/PowerShell acceptance checks |

## License

MIT
