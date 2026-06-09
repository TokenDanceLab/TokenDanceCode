# TokenDanceCode

> Rust rewrite branch for a local command-line Coding Agent. Windows / PowerShell first, AgentHub SDK surface preserved.

[English](README.en.md) · [AgentHub SDK](docs/agenthub-sdk.md) · [发布准备](docs/release-readiness.md) · [TS 路线图](docs/TS重构路线图.md)

![Screenshot: TokenDanceCode CLI terminal session](docs/images/image-01.png)

截图展示了 `tokendance` 在 PowerShell 中启动后的本地 CLI 体验。

## Rust 重写状态

This branch is an aggressive Rust rewrite of the current TypeScript implementation. The TypeScript packages remain in the repository as contract references while the Rust crates take over the active runtime.

Active crates:

- `crates/tokendance-core`: runtime, provider trait, permissions, session, transcript.
- `crates/tokendance-sdk`: AgentHub facade and event mapping.
- `crates/tokendance-cli`: `tokendance` binary.

First baseline commands:

```powershell
cargo test --workspace
cargo run -p tokendance-cli -- --version
cargo run -p tokendance-cli -- doctor --json
cargo run -p tokendance-cli -- run --json "hello"
```

See [docs/rust-rewrite-architecture.md](docs/rust-rewrite-architecture.md) for ownership, migration order, and release gates.

## 项目定位

TokenDanceCode 是一个本地 CLI Agent。你可以在代码仓库里运行 `tokendance`，让它阅读代码、修改文件、执行受权限系统保护的 PowerShell 工具、检查 Git diff、管理任务，并把每轮运行写入 JSONL transcript。

当前代码库已经重构为 TypeScript monorepo。它参考 Claude Code、Codex CLI 和 OpenCode 的可取设计，但只保留适合自用框架的部分：薄 CLI、SDK、结构化事件、transcript、provider adapter、权限管线和可测试的发布门禁。

TokenDanceCode 聚焦本地 coding-agent runtime 和 AgentHub 可调用的 SDK surface。团队协作、多 Agent 编排和产品侧工作流由 AgentHub 承担。

## 当前状态

| 模块 | 状态 | 说明 |
|---|---|---|
| CLI | 可用 | `tokendance`、`run`、`doctor`、`config`、`resume`、`quality`、`transcript` |
| Runtime | 可用 | session、event stream、tool orchestration、permission engine、JSONL transcript |
| Provider | 可用 | OpenAI Responses API、OpenAI Chat Completions API 与 Anthropic-compatible Messages API |
| TokenDance Gateway | 可用 | 通过 OpenAI-compatible Chat Completions adapter 接入，API key 平面与 TokenDanceID 登录平面分离 |
| AgentHub SDK | 可用 | thread run/context、event sink、approval bridge、doctor/config、task/todo/subagent/worktree facade |
| Subagent / worktree | 早期可用 | 适合隔离修改型任务，还不是常驻团队系统 |
| npm 发布 | next 准备中 | 发布门禁已文档化；真实发布前重新运行 `pnpm release:next:check`，registry 状态见 [发布准备](docs/release-readiness.md) |

当前 public npm 包计划为：

- `@tokendance/code-core`
- `@tokendance/code-sdk`
- `@tokendance/code-cli`

`@tokendance/code-agenthub-example` 仍是私有 workspace 示例包，不进入 npm 发布队列。

## 快速开始

源码安装：

```powershell
git clone https://github.com/TokenDanceLab/TokenDanceCode.git
cd TokenDanceCode
pnpm install
pnpm verify
```

构建并运行 CLI：

```powershell
pnpm --filter @tokendance/code-cli build
node packages/cli/dist/main.js --version
node packages/cli/dist/main.js quickstart
node packages/cli/dist/main.js doctor
node packages/cli/dist/main.js run "hello"
```

没有配置 API key 时，CLI 使用 MockProvider，适合做安装、SDK、transcript 和 pack smoke 验证。

## 常用命令

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

交互式 CLI 支持 `/status`、`/permissions`、`/config`、`/doctor`、`/diff`、`/review`、`/quality`、`/tasks`、`/todo`、`/worktree`、`/agents`、`/transcript`、`/context`、`/compact`、`/memory`、`/resume` 等 slash commands。命令说明来自同一份 metadata registry，减少 help、usage 和 handler 漂移。

## Provider 与凭据边界

TokenDanceCode 默认不读取项目根目录 `.env`。项目 `.env` 通常属于业务应用，可能包含应用密钥；AgentHub 或脚本需要注入 provider key 时，应通过 SDK `env` 或受控 shell 环境传入。

| Provider | API key | Base URL |
|---|---|---|
| `openai-responses` | `OPENAI_API_KEY` | `OPENAI_BASE_URL`，默认 `https://api.openai.com/v1` |
| `openai-chat-completions` | `TOKENDANCE_GATEWAY_API_KEY`，缺省回退 `OPENAI_API_KEY` | Gateway key 使用 `TOKENDANCE_GATEWAY_BASE_URL`；OpenAI fallback key 使用 `OPENAI_BASE_URL` |
| `anthropic-messages` | `ANTHROPIC_API_KEY` | `ANTHROPIC_BASE_URL`，默认 `https://api.anthropic.com` |

TokenDance Gateway 的模型调用使用 TokenDance API key。TokenDanceID/OIDC token 属于身份会话平面，不是模型 API key。

## SDK 给 AgentHub 使用

AgentHub 应优先依赖 `@tokendance/code-sdk`，不要直接调用 core internals。

```ts
import { TOKEN_DANCE_CODE_PACKAGE, TokenDanceCode } from "@tokendance/code-sdk";

console.log(TOKEN_DANCE_CODE_PACKAGE.agentHub.features);

const client = new TokenDanceCode({
  storageRoot: "<agenthubProject>/.tokendance-code",
  env: process.env,
  eventSink(event) {
    console.log(event.type);
  }
});

const thread = client.startThread({
  workingDirectory: "<agenthubProject>",
  permissionMode: "default"
});

const turn = await thread.run("summarize this repo");
console.log(turn.finalResponse);
```

SDK 已提供：

- `TokenDanceCode -> Thread -> run() / runStreamed() / context()`
- AgentHub `agent.stream` event sink
- remote approval bridge
- doctor/config readiness facade
- transcript/search/session lifecycle helpers
- task/todo/subagent/worktree facade
- AgentHub-readable `tools.list()` catalog with `permissionProfiles.default/safe/auto/yolo`
- TokenDanceID OIDC Authorization Code + PKCE login URL helper

详细接入说明见 [docs/agenthub-sdk.md](docs/agenthub-sdk.md)。

## 项目结构

```text
packages/
  core/               runtime、provider、tools、permissions、transcript
  sdk/                AgentHub 和本地脚本使用的 public SDK
  cli/                tokendance 命令入口和滚动式终端 renderer
  agenthub-example/   私有 AgentHub 接入示例包
docs/
  agenthub-sdk.md
  release-readiness.md
  TS重构路线图.md
  架构对标评估.md
```

旧 Python `src/tokendance` 和 `tests/` 只作为 v0.1 迁移参考保留；TS 分支不再扩展旧 Python runtime。

## 开发与验证

```powershell
pnpm typecheck
pnpm test
pnpm verify
pnpm contract:check
pnpm pack:smoke
pnpm release:next:check
```

`pnpm release:next:check` 会运行 `pnpm contract:check && pnpm verify && pnpm pack:check`，覆盖 typecheck、Vitest、build、dry-run pack 和本地 tarball install smoke。

不要在检查脚本中执行 npm publish。`npm publish --tag next` 是 release owner 审核包内容、dist-tag、registry 状态和 npm 登录后的手动步骤。完整发布说明见 [docs/release-readiness.md](docs/release-readiness.md)。

## 文档

| 文档 | 内容 |
|---|---|
| [docs/agenthub-sdk.md](docs/agenthub-sdk.md) | SDK、AgentHub event、approval bridge、OIDC helper |
| [docs/release-readiness.md](docs/release-readiness.md) | npm first candidate、registry 检查、发布后 smoke |
| [docs/TS重构路线图.md](docs/TS重构路线图.md) | TS 重构任务和已完成能力 |
| [docs/架构对标评估.md](docs/架构对标评估.md) | Claude Code / Codex / OpenCode 对标决策 |
| [docs/端到端验收清单.md](docs/端到端验收清单.md) | Windows/PowerShell 验收步骤 |

## License

MIT
