# TokenDanceCode

TokenDanceCode 是一个面向个人开发者的本地命令行 Coding Agent。

你可以在任意本地代码仓库中打开终端，运行 `tokendance`，然后让它阅读项目、修改文件、运行 PowerShell 命令、检查 Git diff、管理任务和 Todo，并把会话过程保存为 transcript。

`codex/ts-refactor` 分支正在把项目重构为 TypeScript monorepo。目标体验接近 Claude Code / Codex CLI，但实现保持自用 Agent 框架的克制范围：薄 CLI、可嵌入 SDK、结构化事件流、JSONL transcript、统一工具权限管线、Windows / PowerShell 优先。

包名和全局命令都是：

```powershell
tokendance
```

![TokenDanceCode 启动界面](docs/images/image-01.png)

## TS 重构当前状态

当前分支已经建立 TypeScript 第一批可验证闭环：

- `@tokendance/code-core`：session、event、runtime、tool registry、permission engine、JSONL transcript store、MockProvider。
- `@tokendance/code-sdk`：AgentHub 可消费的 `TokenDanceCode -> Thread -> run/runStreamed` 编程接口，支持 provider 配置、审批回调、事件下沉、AgentHub runtime event 映射和 recent transcript resume。
- `@tokendance/code-cli`：薄 CLI 入口，支持 `--version`、`doctor`、`run <prompt>`、最小交互式 REPL 和工具事件渲染。
- `@tokendance/code-agenthub-example`：私有示例包，演示 AgentHub emitter 如何通过 SDK 接收 `agent.stream` payload 并桥接远程审批。
- `pnpm verify`：同时执行 TypeScript typecheck 和 Vitest 测试。

旧 Python `src/tokendance` 和 `tests/` 暂时保留为功能迁移参考，不再作为 TS 重构分支新增能力的默认落点。后续迁移按 [docs/TS重构路线图.md](docs/TS重构路线图.md) 推进。

## 目标功能

- 交互式终端 Coding Agent。
- 支持模型流式输出。
- 支持 Anthropic-compatible 模型供应商。
- 内置文件工具：`read_file`、`write_file`、`edit_file`、`glob`。
- 内置 patch 和 PowerShell 工具，并经过权限系统管控。
- 支持 slash commands：状态、配置、diff、review、quality、tasks、todo、transcript、memory、resume、worktree 等。
- 每次会话都会保存 JSONL transcript。
- Git 能力内置：diff、review、revert、quality gate、worktree。
- Windows / PowerShell 是一等支持环境。

## 环境要求

- Node.js 20.18 或更高版本。
- pnpm 10 或更高版本。
- Git。
- Windows 下推荐使用 PowerShell。
- 如果要使用真实模型，后续需要 OpenAI 或 Anthropic-compatible API key。

如果没有配置 API key，当前 TS runtime 可以使用 MockProvider，适合做 SDK、CLI 和 transcript 冒烟测试。

## 从源码安装

克隆仓库：

```powershell
git clone https://github.com/TokenDanceLab/TokenDanceCode.git
cd TokenDanceCode
```

安装依赖：

```powershell
pnpm install
```

验证项目：

```powershell
pnpm verify
```

确认命令可用：

```powershell
pnpm --filter @tokendance/code-cli build
node packages/cli/dist/main.js --version
node packages/cli/dist/main.js doctor
```

运行一次 mock turn：

```powershell
node packages/cli/dist/main.js run "hello"
```

期望输出 `Mock response: hello`。

## 配置模型

TokenDanceCode TS 版当前已提供 OpenAI Responses API 与 Anthropic-compatible Messages API provider adapter。CLI 默认仍使用 MockProvider；AgentHub 或本地脚本可通过 SDK 显式选择 provider。

配置可以放在以下位置：

- 当前 PowerShell 会话环境变量。
- 当前项目根目录的 `.env`。
- 全局 `~/.tokendance/.env`。

### 方式一：当前 PowerShell 会话

使用 Anthropic 官方接口：

```powershell
$env:ANTHROPIC_API_KEY = "your-api-key"
$env:MODEL_ID = "claude-sonnet-4-6"
```

使用 Anthropic-compatible 第三方接口，例如 DeepSeek：

```powershell
$env:ANTHROPIC_API_KEY = "your-api-key"
$env:ANTHROPIC_BASE_URL = "https://api.deepseek.com/anthropic"
$env:MODEL_ID = "deepseek-v4-pro"
```

### 方式二：项目 `.env`

在项目根目录创建 `.env`：

```env
ANTHROPIC_API_KEY=your-api-key
MODEL_ID=claude-sonnet-4-6
```

DeepSeek-compatible 示例：

```env
ANTHROPIC_API_KEY=your-api-key
ANTHROPIC_BASE_URL=https://api.deepseek.com/anthropic
MODEL_ID=deepseek-v4-pro
```

不要把 `.env` 提交到 Git。仓库已经默认忽略它。

## 启动使用

当前 TS CLI 支持一次性 mock 运行和恢复历史 session：

```powershell
node packages/cli/dist/main.js run "完整阅读这个项目"
node packages/cli/dist/main.js resume
node packages/cli/dist/main.js resume <session-id>
node packages/cli/dist/main.js transcript
node packages/cli/dist/main.js transcript <session-id>
node packages/cli/dist/main.js compact
node packages/cli/dist/main.js compact <session-id>
```

工具调用会通过同一套 runtime 事件流渲染，例如 mock echo 工具：

```powershell
node packages/cli/dist/main.js run "echo: hello"
```

会依次显示工具开始、权限决策、工具完成或失败原因，以及最终响应。

交互式入口：

```powershell
node packages/cli/dist/main.js
```

当前已支持：

```text
/new
/status
/permissions safe
hello
/exit
```

当前 SDK 可供 AgentHub 或本地脚本嵌入：

```ts
import { TokenDanceCode } from "@tokendance/code-sdk";

const client = new TokenDanceCode();
const thread = client.startThread({ workingDirectory: process.cwd() });
const turn = await thread.run("summarize repo");
console.log(turn.finalResponse);

const resumed = await client.resume({ storageRoot: process.cwd() });
console.log(resumed.recentTranscript.length);

const transcript = await resumed.transcript();
console.log(transcript.transcriptPath);
```

AgentHub 集成可以接管审批和事件分发：

```ts
import { TokenDanceCode } from "@tokendance/code-sdk";

const client = new TokenDanceCode({
  provider: { type: "anthropic-messages", model: "claude-sonnet-4-6" },
  storageRoot: "D:/Code/TokenDance/AgentHub/.tokendance-code",
  env: process.env,
  approvalCallback(request) {
    return request.tool.risk !== "dangerous";
  },
  eventSink(event) {
    console.log(event.type);
  }
});
```

需要对接 AgentHub `run.agent.*` 事件时，可使用 `createAgentHubEventSink()` 或 `toAgentHubRuntimeEvents()`；需要 Hub/UI 异步审批时，可使用 `createAgentHubApprovalBridge()`。

需要可复制的 Hub/Edge emitter 示例时，可参考私有 workspace 包 `packages/agenthub-example`。详细说明见 [docs/agenthub-sdk.md](docs/agenthub-sdk.md)。

## Slash Commands

当前 TS 版已支持：

```text
/help
/new
/status
/doctor
/permissions default
/permissions safe
/permissions auto
/permissions yolo
/resume
/transcript
/compact
/exit
```

后续迁移继续补：

```text
/config
/diff
/review
/quality pnpm verify
/tasks
/todo
/transcript search <query>
/memory
/worktree
```

权限模式说明：

- `default`：默认受保护模式。
- `safe`：写入和高风险操作更谨慎。
- `auto`：自动允许更多常规操作。
- `yolo`：限制最少，使用时要小心。

## 项目结构

```text
TokenDanceCode/
├── package.json
├── pnpm-workspace.yaml
├── tsconfig.base.json
├── README.md
├── docs/
├── packages/
│   ├── core/         # runtime、session state、events、tools、permissions、transcript
│   ├── sdk/          # AgentHub 和脚本调用的稳定编程接口
│   ├── cli/          # tokendance 命令入口与最小交互 shell
│   └── agenthub-example/ # AgentHub SDK 集成样例
├── src/tokendance/   # Python v0.1 参考实现，TS 迁移期间保留
└── tests/            # Python v0.1 参考测试，TS 迁移期间保留
```

## 开发与测试

安装开发依赖：

```powershell
pnpm install
```

运行 TS 闭环：

```powershell
pnpm verify
```

运行单项：

```powershell
pnpm typecheck
pnpm test
```

检查 CLI：

```powershell
tokendance doctor
```

## 给新用户的注意事项

- 在哪个目录运行 `tokendance`，哪个目录就是当前 workspace root。
- 会话 transcript 会保存到当前项目的 `.tokendance/` 下。
- `glob` 工具默认排除 `.git`、`.tokendance`、虚拟环境、缓存目录、build/dist、`node_modules` 和 `.env`。
- CLI 通过 runtime event 渲染工具开始、权限决策、工具完成、失败原因、成功结果摘要和 assistant 文本；后续会继续补更细的进度显示。
- 真实模型集成测试默认跳过，需要显式配置相关环境变量后才会运行。
- AgentHub 集成应使用 SDK 的 `approvalCallback` / `createAgentHubApprovalBridge()` 和 `eventSink`，不要直接调用 core runtime 内部类。

## 当前状态

TokenDanceCode TS 版目前还是早期本地 Agent 实现，适合开发、测试和自用验证。

它还不是正式发布到 npm 的包。后续会继续补充正式发布流程、安装包、首次运行向导、更多 slash commands、更细的事件 renderer 和更完整的 AgentHub 端到端示例。
