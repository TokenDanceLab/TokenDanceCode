# TokenDanceCode TS 重构路线图

日期：2026-06-09

## 1. 当前分支事实

- 分支：`codex/ts-refactor`
- worktree：`D:\Code\TokenDance\TokenDanceCode\.worktrees\ts-refactor`
- 目标：把 TokenDanceCode 从 Python v0.1 参考实现重构为 TypeScript monorepo，并给 AgentHub 暴露稳定 SDK。
- 当前可验证命令：`pnpm verify`
- 最近验证结果：typecheck 通过，Vitest 8 个测试文件 31 个测试通过。

旧 `src/tokendance` 和 `tests/` 暂时保留为功能迁移参考。新增 TS 能力默认写入 `packages/*`，不要继续扩展 Python 运行时，除非明确是在补迁移对照或保护旧行为。

## 2. 参考来源

本轮只读参考了 AgentHub 的源码镜像：

- `D:\Code\TokenDance\AgentHub\reference\claude-code-source\claude-code-main`
- `D:\Code\TokenDance\AgentHub\reference\claude-code-viewer`
- `D:\Code\TokenDance\AgentHub\reference\codex`

可借鉴但不照搬的结论：

- CLI 保持薄入口，负责参数、REPL 和事件渲染，不直接调用模型或执行工具。
- Core runtime 输出结构化事件；CLI、SDK、transcript writer 消费同一事件流。
- Tool call 必须统一经过 registry、schema parse、permission、execution、result serialization 和 transcript。
- Approval policy 和 sandbox/execution policy 分开建模，首版先覆盖 Windows/PowerShell 风险分类。
- JSONL transcript 是 session/resume/viewer 的事实源。
- SDK 暴露 `TokenDanceCode -> Thread -> run/runStreamed`，不要把内部 runtime 类作为集成边界。

首版不做：

- MCP marketplace、插件、skills 生态。
- daemon/app-server/remote-control/IDE bridge。
- 多 agent swarm/team、cron/scheduled agent。
- 复杂 telemetry、feature flag、rollout trace。
- 全平台强 sandbox。首版先做好 Windows/PowerShell 自用边界。

## 3. TS 包边界

当前已落地：

| 包 | 职责 | 状态 |
|---|---|---|
| `@tokendance/code-core` | session、runtime、event、tool registry、permission engine、transcript、MockProvider | 已建骨架和测试 |
| `@tokendance/code-sdk` | AgentHub/本地脚本可消费的 `Thread` API | 已建骨架和测试 |
| `@tokendance/code-cli` | `tokendance` 命令入口和未来交互 shell | 已建薄入口 |

后续视复杂度拆分；在首版功能还小的时候，不急于拆成过多包。优先保持 core 内部边界清楚。

候选拆分：

- `@tokendance/code-models`：OpenAI/Anthropic provider adapter、stream normalization、retry/token accounting。
- `@tokendance/code-execution`：local shell、PowerShell classifier、file/patch/git executor。
- `@tokendance/code-context`：system prompt、workspace context、compact summary boundary、resume recovery。

## 4. 开发闭环

每个切片必须同时补齐三件事：

1. 代码：放入对应 `packages/*`，保持 CLI、SDK、core 边界。
2. 测试：单元测试优先覆盖 public API、permission decision、transcript/resume 事实源、tool orchestration。
3. 文档：更新 README、架构文档、本路线图或验收清单中的当前事实。

基础验证：

```powershell
pnpm verify
```

涉及 CLI 行为时额外运行：

```powershell
pnpm --filter @tokendance/code-cli build
node packages/cli/dist/main.js doctor
node packages/cli/dist/main.js run "hello"
```

涉及 SDK 行为时至少新增或更新 `packages/sdk/tests/*.test.ts`。

## 5. 下一步队列

### P0：TS runtime 可用骨架

- [x] 建立 pnpm workspace、TypeScript project references、Vitest。
- [x] 建立 core/sdk/cli 三包。
- [x] 实现 MockProvider、tool loop、permission event、transcript append、SDK run/runStreamed。
- [x] 引入 `turnId`，把 `sessionId` 和单次 turn 生命周期分离。
- [x] transcript schema 增加 `uuid/parentUuid/timestamp/version/cwd`，为 resume 做准备。
- [x] SDK `runStreamed()` 在事件消费完成后再同步 thread session state。

### P1：自用 Agent 基础能力

- [ ] Provider adapter：OpenAI Responses API。
- [ ] Provider adapter：Anthropic-compatible Messages API。
- [x] File tools：read/write/edit/glob，全部走 permission engine。
- [x] PowerShell shell tool：风险分类、工作区边界、输出截断。
- [x] Patch tool：结构化 apply patch，失败可诊断。
- [ ] Git tool：status/diff/review quality gate 的最小集合。
  - 已完成：`git_status`、`git_diff`、`git_log`、`git_branch` 只读工具。
  - 待完成：review finding 和 quality gate。

### P2：上下文与恢复

- [ ] Context builder：system prompt、AGENTS.md/README 摘要、recent messages。
- [ ] Compact：确定性 summary boundary，不引入复杂 microcompact。
- [ ] Resume：从 JSONL 恢复 session，过滤未闭合 tool call 和坏链路。
- [ ] Memory：先支持项目/全局 Markdown 读取，不做自动抽取。

### P3：AgentHub SDK 包装

- [ ] 固化 `TokenDanceCodeOptions`：provider、storageRoot、env、approval callback、event sink。
- [ ] 输出 AgentHub 可直接消费的 typed event union。
- [ ] 增加 `Thread.resume()` / `client.loadThread()` 集成测试。
- [ ] 编写 AgentHub 接入示例：启动 thread、流式事件、审批回调、读取 transcript。

### P4：CLI 体验

- [ ] 交互式 REPL。
- [ ] `/status`、`/doctor`、`/permissions`。
- [ ] `/resume`、`/compact`。
- [ ] 滚动式事件 renderer。
