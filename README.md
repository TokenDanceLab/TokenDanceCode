# TokenDanceCode

> 本地 Coding Agent Runtime — TypeScript + Rust 双引擎并行
> Local Coding Agent Runtime — TypeScript & Rust dual-engine

![TokenDanceCode CLI](docs/images/tokendance-cli-hero.svg)

[English](README.en.md) · [AgentHub SDK](docs/agenthub-sdk.md) · [发布准备](docs/release-readiness.md)

---

## 什么是 TokenDanceCode

TokenDanceCode 是一个**本地命令行 Coding Agent**。在代码仓库里运行 `tokendance`，它能：

- 📖 **阅读代码** — 搜索文件、正则匹配、Glob 模式
- ✏️ **修改文件** — 精确字符串替换、整文件写入
- ⚡ **执行命令** — PowerShell 工具，受权限系统保护
- 🔄 **管理会话** — JSONL transcript、session resume、上下文压缩
- 🤖 **扩展能力** — MCP 工具协议、Subagent 编排

面向**个人仓库**、**Windows / PowerShell 优先**，同时为 AgentHub 提供**可嵌入 SDK**。

## 双引擎架构

TokenDanceCode 同时维护 TypeScript 和 Rust 两套实现，功能对齐，API 兼容：

| | TypeScript | Rust |
|---|---|---|
| **位置** | `packages/` | `crates/` |
| **测试** | Vitest (pnpm verify) | cargo test (204 tests) |
| **运行时** | Node.js | Native binary |
| **npm 包** | `@tokendance/code-*` | 通过 wrapper shim 转发 |
| **状态** | ✅ 生产可用 | ✅ 核心功能对齐 |

两套实现**共存于同一仓库**，共享 `docs/`、`scripts/` 和 CI 配置。npm wrapper 优先调用 Rust binary，自动 fallback 到 TypeScript。

## 快速开始

### Rust（推荐）

```bash
git clone https://github.com/TokenDanceLab/TokenDanceCode.git
cd TokenDanceCode
cargo run -p tokendance-cli -- --version     # tokendance 0.3.0-rs.0
cargo run -p tokendance-cli -- doctor --json  # 健康检查
cargo run -p tokendance-cli -- run "hello"    # 单次运行
cargo test --workspace                        # 204 tests
```

### TypeScript

```bash
pnpm install
pnpm verify                                   # typecheck + vitest
node packages/cli/dist/main.js --version
node packages/cli/dist/main.js doctor --json
```

### 交互式 REPL

```bash
cargo run -p tokendance-cli                   # 进入交互模式
tokendance> read the main.rs file
tokendance> summarize this repo
tokendance> /help
tokendance> /exit
```

## 功能全景

### 🔧 内置工具 (7)

| 工具 | 风险 | 说明 |
|------|------|------|
| `read_file` | Read | 读取工作区文件，自动路径安全检查 |
| `write_file` | Write | 写入文件，受权限门控 |
| `edit_file` | Write | 精确字符串替换（`old_string` → `new_string`），支持 `replace_all` |
| `glob` | Read | 文件模式匹配，按修改时间排序 |
| `grep` | Read | 正则搜索，支持 content/files_with_matches/count 三种模式 |
| `run_powershell` | Shell | 执行 PowerShell 命令，破坏性命令硬拦截 |
| `echo` | Read | 测试用回显工具 |

### 🌐 Provider 传输 (3)

| Provider | 认证 | 传输门控 |
|----------|------|----------|
| OpenAI Chat Completions | `TOKENDANCE_GATEWAY_API_KEY` → `OPENAI_API_KEY` | `TOKENDANCE_GATEWAY_HTTP_TRANSPORT=1` |
| OpenAI Responses | `TOKENDANCE_OPENAI_API_KEY` → `OPENAI_API_KEY` | `TOKENDANCE_OPENAI_TRANSPORT=1` |
| Anthropic Messages | `TOKENDANCE_ANTHROPIC_API_KEY` → `ANTHROPIC_API_KEY` | `TOKENDANCE_ANTHROPIC_TRANSPORT=1` |

所有 Provider 自动遮盖 API key，错误信息中不泄露凭证。

### 🛡️ 安全体系

- **4 级权限模式**: Default → Safe → Auto → Yolo
- **工具风险分类**: Read / Write / Shell / Network / Dangerous
- **路径安全**: 工作区路径归一化，阻止目录穿越和 symlink 逃逸
- **破坏性命令拦截**: PowerShell `Remove-Item`、`format-volume` 等硬拒绝
- **Sandboxing 抽象**: Windows restricted token / macOS Seatbelt / Linux bwrap

### 🔌 扩展能力

| 系统 | 说明 |
|------|------|
| **MCP Client** | stdio JSON-RPC 协议，动态工具发现，`mcp__{server}__{tool}` 命名空间 |
| **Subagent** | 独立 session + 受限工具集 + 递归防护，支持多 Agent 编排 |
| **Hooks** | PreToolUse / PostToolUse / TurnCompleted / TurnFailed 生命周期钩子 |
| **Memory** | Markdown 文件持久化记忆，跨 session 保持上下文 |
| **Instruction Discovery** | 自动发现 AGENTS.md / CLAUDE.md，Global → Project → Local 三层覆盖 |

### 📡 会话与流式

- **JSONL Transcript** — 仅追加，崩溃可恢复，UUID 父子链
- **SSE 流式解析** — 增量缓冲，多行数据，注释跳过
- **StreamEvent** — ContentDelta / ToolStarted / TurnCompleted 实时事件
- **Session Resume** — 从 transcript 重放恢复完整消息历史
- **Context Compaction** — 超阈值自动压缩旧消息

## 项目结构

```
TokenDanceCode/
├── crates/                          # Rust 实现
│   ├── tokendance-core/             #   Runtime, Provider, Tools, Permissions
│   ├── tokendance-sdk/              #   AgentHub SDK facade
│   └── tokendance-cli/              #   CLI binary
├── packages/                        # TypeScript 实现
│   ├── core/                        #   Runtime, Provider, Tools
│   ├── sdk/                         #   AgentHub SDK
│   ├── cli/                         #   CLI + REPL
│   └── agenthub-example/            #   接入示例 (private)
├── docs/                            # 共享文档
├── scripts/                         # 验证 & 发布脚本
├── Cargo.toml                       # Rust workspace
├── package.json                     # npm workspace
└── README.md
```

## CLI 命令

```bash
tokendance                              # 交互式 REPL
tokendance run "summarize this repo"    # 单次运行
tokendance run --json "hello"           # 结构化 JSON 输出
tokendance run --stream-json "hello"    # 流式 JSONL 输出
tokendance doctor --json                # 健康检查
tokendance config validate --json       # 配置校验
tokendance sessions list                # 列出会话
tokendance transcript search "needle"   # 搜索 transcript
tokendance quality                      # 质量概览
```

REPL 内置 slash commands: `/help` `/status` `/exit` `/compact`

## SDK 接入（AgentHub）

```ts
import { TokenDanceCode } from "@tokendance/code-sdk";

const client = new TokenDanceCode({
  storageRoot: "~/.tokendance",
  env: process.env,
  eventSink(event) { console.log(event.type); }
});

const thread = client.startThread({
  workingDirectory: process.cwd(),
  permissionMode: "default"
});

const turn = await thread.run("summarize this repo");
console.log(turn.finalResponse);
```

详见 [AgentHub SDK 文档](docs/agenthub-sdk.md)。

## Rust 模块清单 (20 modules, 204 tests)

| 模块 | 功能 |
|------|------|
| `config` | Settings 加载 / 验证 / 合并 |
| `permissions` | 4-mode 权限引擎 |
| `provider` | ModelProvider trait + MockProvider |
| `providers/*` | OpenAI Chat / Responses / Anthropic HTTP 传输 |
| `runtime` | Agent loop + streaming + hooks 集成 |
| `tools` | 7 内置工具 + ToolExposure + MCP 注册 |
| `transcript` | JSONL 追加 / session resume |
| `streaming` | SSE 增量解析器 |
| `context` | Instruction 发现 (AGENTS.md / CLAUDE.md) |
| `memory` | 持久化记忆 CRUD |
| `hooks` | 生命周期钩子 |
| `mcp` | MCP client (stdio JSON-RPC) |
| `subagent` | Subagent 生成 / 隔离 |
| `compact` | 上下文压缩 |
| `sandbox` | 跨平台沙箱抽象 |
| `worktree` | Git worktree 管理 |
| `types` | 核心类型 + RuntimeEvent |

## 验证

```bash
# Rust 验证
cargo fmt --all -- --check
cargo test --workspace                    # 204 tests
cargo run -p tokendance-cli -- doctor

# TypeScript 验证
pnpm verify

# 发布准备
node scripts/check-rust-release-plan.mjs
node scripts/smoke-rust-release.mjs
```

## 文档

| 文档 | 内容 |
|------|------|
| [架构设计](docs/rust-rewrite-architecture.md) | Rust 重写架构：20 个模块的设计决策 |
| [当前状态](docs/rust-rewrite-status.md) | Phase 1–5 完成记录，模块状态表 |
| [工具参考](docs/rust-tool-reference.md) | 7 个内置工具的输入/输出 schema |
| [发布清单](docs/rust-release-checklist.md) | Release owner 发布前检查项 |
| [AgentHub SDK](docs/agenthub-sdk.md) | SDK 接入、event sink、approval bridge |
| [发布准备](docs/release-readiness.md) | npm 发布门禁和 registry 状态 |
| [架构对标](docs/架构对标评估.md) | Claude Code / Codex / OpenCode 对标分析 |

## License

MIT
