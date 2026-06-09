# TokenDanceCode TS 重构路线图

日期：2026-06-09

## 1. 当前分支事实

- 分支：`codex/ts-refactor`
- worktree：`D:\Code\TokenDance\TokenDanceCode\.worktrees\ts-refactor`
- 目标：把 TokenDanceCode 从 Python v0.1 参考实现重构为 TypeScript monorepo，并给 AgentHub 暴露稳定 SDK。
- 当前可验证命令：`pnpm verify`、`pnpm pack:check`、`pnpm release:next:check`
- 最近验证结果：`pnpm release:next:check` 通过，覆盖 typecheck、Vitest 26 个测试文件 179 个测试、core/sdk/cli dry-run pack 和 tarball install smoke。

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
| `@tokendance/code-core` | session、runtime、event、tool registry、permission engine、transcript、task/todo、subagent、worktree、MockProvider | 已建骨架和测试 |
| `@tokendance/code-sdk` | AgentHub/本地脚本可消费的 `Thread` API 和 facade | 已建骨架和测试 |
| `@tokendance/code-cli` | `tokendance` 命令入口、最小交互 shell、task/todo 管理、工具事件渲染 | 已建薄入口和 REPL |
| `@tokendance/code-agenthub-example` | AgentHub emitter/审批桥接样例 | 已建私有示例包和测试 |

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
pnpm pack:check
pnpm pack:smoke
pnpm release:next:check
```

`pnpm pack:smoke` 会把 `@tokendance/code-core`、`@tokendance/code-sdk`、`@tokendance/code-cli` 的真实 tarball 安装到临时项目中，验证 SDK import、mock turn 和 CLI bin 启动。`pnpm release:next:check` 是 npm `next` 预发布前的本地门禁，覆盖 `pnpm verify && pnpm pack:check`。不要在检查脚本中执行 npm publish；`npm publish --tag next` 只作为 release owner 审核后的人工发布动作。

### Release owner 检查清单

Manual approval gate：本地 release gate 只运行 `pnpm release:next:check`、`pnpm pack:check` 和 `pnpm pack:smoke`，不执行 npm 写操作。release owner 在批准 `npm publish --tag next` 前，需要确认版本一致、`publishConfig.tag=next`、包内容只包含发布所需文件、package-local README 与根 README 一致、npm 登录和 2FA 状态由本人可控。

AgentHub consumption story：AgentHub 消费 `@tokendance/code-sdk`，读取 `TOKEN_DANCE_CODE_PACKAGE` 做启动检查，使用 thread API、event sink、approval bridge、config 和 doctor facade。`@tokendance/code-core` 继续作为 SDK/CLI runtime 依赖，`@tokendance/code-cli` 提供本地 `tokendance` bin，`@tokendance/code-agenthub-example` 只作为私有复制样例，不发布到 npm。

Residual risk matrix：

| 风险 | 当前状态 | 后续处理 |
|---|---|---|
| npm 发布动作不可由本地检查证明 | 检查脚本明确不发布 | Manual approval gate 后由 release owner 逐包执行 |
| 真实 provider smoke 依赖外部 key | 默认测试不读取项目 `.env`，真实集成测试显式 opt-in | 需要时由 release owner 在受控 shell 注入 |
| AgentHub 生产接入仍需产品侧替换样例存储 | SDK 和 example 覆盖 contract 与事件形态 | Hub/Edge 合并时替换为自己的 event bus、approval store 和 session 生命周期 |
| Python v0.1 验收项仍在文档后半段 | TS 权威验收已前置 | 后续迁移切片继续替换旧项 |

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

- [x] Provider adapter：OpenAI Responses API。
- [x] Provider adapter：Anthropic-compatible Messages API。
- [x] File tools：read/write/edit/glob，全部走 permission engine。
- [x] PowerShell shell tool：风险分类、工作区边界、输出截断。
- [x] Patch tool：结构化 apply patch，失败可诊断。
- [x] Git tool：status/diff/review quality gate 的最小集合；quality gate 可自动发现 `package.json` 的 `verify`/`test` 脚本，显式命令可覆盖。
- [x] Tool metadata：默认 registry 和 SDK/CLI 可列出工具名称、说明、风险等级和并发属性。
- [x] Worktree manager/tool：受控 `.worktrees` list/create/remove，dirty 删除需显式 `--discard`，并暴露 `worktree_list/create/remove` 默认 registry tools。
- [x] Subagent manager/tool：readonly investigator/reviewer、coding worktree delegation、agent transcript/index、accept/discard 生命周期管理、target dirty 保护、dirty worktree 丢弃保护、`subagent_run/list/get/accept/discard` 默认 registry tools。
- [x] Config loader：合并 defaults/global/project JSON 配置，只暴露 provider、model、permissionMode 白名单字段。
- [x] Config loader：支持 env hint source；`MODEL_ID`/`TOKENDANCE_MODEL` 可设置模型，`TOKENDANCE_PROVIDER` 可显式设置 provider，`MODEL_ID` 加 OpenAI/Anthropic key 可推断 provider，且不暴露 secret。

### P2：上下文与恢复

- [x] Context builder：system prompt、AGENTS.md/CLAUDE.md/README 摘要、compact summary、memory、recent messages，并接入 runtime provider request；transient context 不写回 session/transcript。
- [x] Compact：确定性 summary boundary，不引入复杂 microcompact。
- [x] Resume：从 JSONL 恢复 session，过滤未闭合 tool call 和坏链路。
- [x] Transcript metadata/search：SDK/CLI 可展示 sessionDir、transcriptPath、eventCount，并搜索源事件匹配。
- [x] Compact helper：SDK/CLI 可对 latest 或指定 session 生成 compact summary。
- [x] Memory：支持项目/全局 Markdown 读写删除、SDK facade 和 CLI 管理入口，不做自动抽取。
- [x] Task/Todo store：持久 task 事件流 + 可重建索引，session/project todo JSON，区分长期任务和短期计划。

### P3：AgentHub SDK 包装

- [x] 固化 `TokenDanceCodeOptions`：provider、storageRoot、env、approval callback、event sink。
- [x] 输出 AgentHub 可直接消费的 typed event union。
- [x] SDK 审批回调与 event sink 集成测试。
- [x] SDK 远程审批 bridge：把 requires_approval 暴露给 AgentHub，再等待 allow/deny 决策回填。
- [x] 编写 AgentHub 接入示例：启动 thread、流式事件、审批回调、读取 transcript。
- [x] 提供 `TDCodeEvent` -> AgentHub `run.agent.*` runtime event mapper。
- [x] 提供 AgentHub `agent.stream` payload sink fixture。
- [x] 暴露 `thread.state` session snapshot，供 AgentHub 读取当前 thread 状态。
- [x] 暴露 `thread.context(input)` transient preview，供 AgentHub 调试面板预览下一轮 provider context，且不污染 session/transcript。
- [x] 增加 SDK `client.resume({ sessionId?, storageRoot? })` 便捷入口，兼容 latest/by-id resume。
- [x] 增加 SDK `thread.searchTranscript(query, { limit? })`，供 AgentHub 调试面板或轻量索引读取匹配事件。
- [x] 增加 SDK `client.memory({ projectRoot?, homeDir? })`，供 AgentHub 管理 project/global memory。
- [x] 增加 SDK `client.tasks({ projectRoot? })` 和 `client.todos({ projectRoot?, sessionId? })`，供 AgentHub 管理任务图和 session todo。
- [x] 增加 SDK `client.subagents({ projectRoot? })`，供 AgentHub 启动 readonly/coding subagent、读取 agent run 记录，并接受或丢弃 coding subagent 的隔离 worktree。
- [x] 增加 SDK `client.worktrees({ repositoryRoot?, worktreeRoot? })`，供 AgentHub 管理 coding subagent 的隔离 worktree 池。
- [x] 增加 SDK `client.tools({ workingDirectory?, permissionMode? })`，供 AgentHub 查看工具能力 metadata、触发受控工具执行、Git diff/review、worktree 和质量门。
- [x] 增加 SDK `client.config({ projectRoot?, homeDir? })`，供 AgentHub 读取有效配置和来源。
- [x] 增加 SDK `client.setConfig(config, { projectRoot?, homeDir?, scope? })`，供 AgentHub 写入 project/global 安全配置白名单字段；不接受 API key/token/secret 作为 JSON 配置。
- [x] 增加 SDK `client.validateConfig({ projectRoot?, homeDir? })`，供 AgentHub 启动检查或设置页验证 provider readiness；只返回 env 名和 present/missing，不泄露 secret。
- [x] 增加 SDK `client.doctor({ projectRoot?, homeDir? })`，供 AgentHub 读取结构化诊断；包含有效 provider/model、provider readiness 和 `provider-ready` startup check，只返回 API key present/missing，不泄露 secret。
- [x] AgentHub 样例 runner 按 Hub `sessionId` resume-or-start，连续 run 会恢复 provider 可见消息历史，并保持 transcript `seq` 连续递增。
- [x] AgentHub 样例 runner 暴露 `context()`，供 Hub 调试面板按 Hub `sessionId` 预览下一轮 provider context，且不发 `agent.stream`、不写 transcript。
- [x] 增加 TokenDanceID OIDC login helper：生成 Authorization Code + PKCE S256 登录 URL、`state/nonce/codeVerifier`，校验 callback state；不交换 token、不保存 TokenDanceID access/refresh token，供 AgentHub Hub/Desktop/Web 启动登录流。
- [x] AgentHub 样例 runner 暴露 TokenDanceID OIDC login facade：AgentHub shell 可生成登录 URL、校验 callback state，并把 code/codeVerifier 交给 Hub Server 做 exchange、JWKS 验证和 Hub-local session。
- [x] 增加 AgentHub 侧最小集成样例包，覆盖 SDK 事件映射、Hub/Edge emitter 形态、package manifest 和 doctor 启动诊断。
- [x] 增加发布前 `pack:check`：构建后 dry-run 打包 core/sdk/cli，保护 AgentHub SDK/CLI 包只发布 `dist` 和 `package.json`。
- [x] 增加 SDK `TOKEN_DANCE_CODE_PACKAGE` manifest，供 AgentHub 读取包名、入口、CLI bin 和推荐验证命令。
- [x] 增加 npm `next` 预发布包基线：public 包 manifest 写入 license/repository/publishConfig/README，根 LICENSE 落地，`pack:smoke` 执行本地 tarball install smoke，`release:next:check` 串联 verify 与 pack gate。不要在检查脚本中执行 npm publish；`npm publish --tag next` 保持人工审核步骤。

### P4：CLI 体验

- [x] 交互式 REPL 最小闭环。
- [x] `/new`、`/status`、`/doctor`、`/config`、`/permissions`。
- [x] Doctor 诊断：Node/cwd/platform、API key present/missing、Git/PowerShell 可用性、config 路径/source、有效 provider/model、provider readiness、`.tokendance` 状态目录可写性；不输出 secret 值；顶层 `doctor --json` 和交互式 `/doctor json` 可输出同源结构化诊断。真实 provider 缺 key/model 时作为 `warn` 暴露给 AgentHub Hub startup check，不阻断本地 mock 或启动自检。
- [x] CLI 新 session 启动会消费有效配置：`provider`/`model` 映射到 SDK provider，`permissionMode` 作为 `tokendance` REPL 和 `tokendance run` 的初始权限模式。
- [x] CLI provider key 来源对齐安全边界：读取进程环境和全局 `~/.tokendance/.env`，不默认读取项目 `.env`。
- [x] CLI `config`、REPL 和 `run` 共用同一套有效配置；env-derived provider/model 能直接进入真实 provider 启动路径。
- [x] CLI `config set [--project|--global] provider <provider> model <model> permission-mode <mode>` 和 REPL `/config set ...` 可写入安全 JSON 配置字段，并拒绝 `apiKey` 等非白名单字段。
- [x] CLI `config --json`、`/config json` 和 `config set --json ...` 输出与 SDK config facade 同源的结构化 payload，供 AgentHub shell/脚本读取且不泄露 secret。
- [x] CLI `config validate [--json]` 和 REPL `/config validate [json]` 输出 provider readiness；缺少必需 key/model 时文本模式返回非 0，JSON 模式可供 AgentHub shell 解析。
- [x] OpenAI-compatible Chat Completions provider：支持 `/v1/chat/completions`、`tool_calls`、`role: "tool"` result 映射，并可通过 `TOKENDANCE_PROVIDER=openai-chat-completions` 接入 TokenDance Gateway。
- [x] TokenDance Gateway preset：`tokendance gateway init` 写入全局 provider/model/base URL preset，保留既有 key 且不输出 secret；Gateway API key 与 TokenDanceID/OIDC 登录继续分离。
- [x] TokenDanceID OIDC CLI helper：`tokendance auth tokendanceid login-url --client-id <id> --redirect-uri <uri> [--json]` 生成 authorize URL、`state/nonce/codeVerifier`，便于 AgentHub/Desktop 调试登录启动；不交换或保存 TokenDanceID token。
- [x] 顶层 `config [--json]`、`config validate [--json]`、`config set [--json] [--project|--global] ...`、`resume [session-id]`、`sessions`、`memory [add|delete] [project|global] [value]`、`auth tokendanceid login-url --client-id <id> --redirect-uri <uri> [--json]`、`agents [run investigator|reviewer <prompt>]`、`agents run coding [--worktree name] <prompt>`、`agents show <agent-id>`、`agents accept <agent-id> [--discard-worktree] [--allow-dirty-target]`、`agents discard <agent-id> [--discard]`、`tasks [create|doing|done|link-session|link-worktree] [value]`、`todo [add|doing|done] [value]`、`worktree [list|create|remove] [name] [--discard]`、`diff [path ...]`、`review`、`tools`、`quality <command>`、`transcript [session-id]`、`transcript [session-id] search <query>`、`context [--session session-id] <prompt>`、`compact [session-id]`，交互式 `/config [json]`、`/config validate [json]`、`/config set [json] ...`、`/resume`、`/sessions`、`/memory`、`/auth`、`/agents`、`/tasks`、`/todo`、`/worktree`、`/diff`、`/review`、`/tools`、`/quality`、`/transcript`、`/transcript search <query>`、`/context <prompt>`、`/compact`。
- [x] 滚动式事件 renderer 闭环：assistant 文本、tool started、permission decision、tool completed、tool failed reason、tool duration、tool output summary、turn token usage。
- [x] 增强 renderer：独立 CLI event renderer 合并连续 assistant delta，遇到工具/权限/完成进度时换行，避免未来真实 provider streaming 时一 token 一行。
- [x] 交互式退出保护：`/exit`、`/quit` 前用只读 `git_status` 提示未提交改动，非 Git 目录静默跳过。
