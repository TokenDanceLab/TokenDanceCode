# AgentHub SDK 接入指南

日期：2026-06-09

本文记录 `codex/ts-refactor` 分支当前可用的 TypeScript SDK 集成面。AgentHub 应把 `@tokendance/code-sdk` 当作唯一稳定入口，避免直接依赖 `@tokendance/code-core` 的 runtime 内部类。

## 1. 集成边界

SDK 暴露的稳定调用链：

```ts
TokenDanceCode -> Thread -> run() / runStreamed()
```

AgentHub 可以负责：

- thread 生命周期和 UI 状态。
- 审批弹窗或策略服务。
- 事件持久化、前端广播、任务编排。
- 选择 provider、storage root 和工作目录。

TokenDanceCode 负责：

- session state。
- provider 调用。
- tool registry、parse、permission、execution。
- JSONL transcript。
- recent transcript resume。

## 2. Client Options

```ts
import { TokenDanceCode } from "@tokendance/code-sdk";

const client = new TokenDanceCode({
  storageRoot: "D:/Code/TokenDance/AgentHub/.tokendance-code",
  provider: { type: "mock" },
  env: process.env,
  approvalCallback(request) {
    return request.tool.risk !== "dangerous";
  },
  eventSink(event) {
    console.log(event.type);
  }
});
```

| Option | 用途 |
|---|---|
| `provider` | 可传入已有 `ModelProvider`，或 `{ type: "mock" }`、`{ type: "openai-responses", model }`、`{ type: "anthropic-messages", model }`。 |
| `storageRoot` | transcript/session 写入根目录。未传时使用 thread 的 working directory。 |
| `env` | SDK 内部构造 provider 时读取 API key；用于 AgentHub 注入进程环境或受控配置。 |
| `approvalCallback` | 当权限决策为 `requires_approval` 时调用。返回 `true` 允许，`false` 拒绝，也可返回完整 `PermissionDecision`。 |
| `eventSink` | 每个 runtime event 写入 transcript 后同步推给 AgentHub。 |

真实 provider 的 key 名：

- OpenAI Responses：`OPENAI_API_KEY`
- Anthropic-compatible Messages：`ANTHROPIC_API_KEY`

不要把 API key 写入项目文档或 transcript 示例。

## 3. 启动 Thread

```ts
const thread = client.startThread({
  workingDirectory: "D:/Code/TokenDance/AgentHub",
  permissionMode: "default"
});

const result = await thread.run("summarize this repo");

console.log(result.threadId);
console.log(result.finalResponse);
console.log(thread.state.messages.length);
```

`run()` 会缓冲完整事件并返回：

```ts
{
  threadId: string;
  finalResponse: string;
  events: TDCodeEvent[];
}
```

`thread.state` 返回当前 session 的只读快照副本，方便 AgentHub 做侧栏、调试面板或持久化索引。不要修改这个快照后再期待影响 SDK 内部状态；后续运行仍应通过 `thread.run()` 或 `thread.runStreamed()`。

## 4. 流式事件

```ts
const streamed = await thread.runStreamed("read README and propose next step");

for await (const event of streamed.events) {
  if (event.type === "assistant.delta") {
    process.stdout.write(event.text);
  }
  if (event.type === "tool.permission") {
    console.log(event.decision.status, event.call.name);
  }
}
```

当前事件 union 由 `@tokendance/code-sdk` 重新导出：

```ts
import type { TDCodeEvent } from "@tokendance/code-sdk";
```

AgentHub 前端建议以 `event.type` 做 discriminated union 分发，不要解析 provider 原始响应。

## 5. AgentHub Runtime Event 映射

TokenDanceCode SDK 提供轻量 mapper，把 `TDCodeEvent` 投影为 AgentHub Edge adapter 已使用的 `run.agent.*` 事件名。SDK 不依赖 AgentHub 包；Hub/Edge 仍负责真正的 WebSocket、REST 或 event bus 投递。

```ts
import { createAgentHubEventSink } from "@tokendance/code-sdk";

const client = new TokenDanceCode({
  eventSink: createAgentHubEventSink((event) => {
    edgeEmitter.emit(event.eventType, {
      sessionId: event.sessionId,
      turnId: event.turnId,
      ...event.payload
    });
  })
});
```

当前映射：

| TokenDanceCode event | AgentHub runtime event |
|---|---|
| `assistant.delta` | `run.agent.text_delta` |
| `assistant.completed` | `run.agent.text_block` |
| `tool.started` | `run.agent.tool_call` |
| `tool.permission` + `requires_approval` | `run.agent.permission_requested` |
| `tool.permission` + `allowed/denied` | `run.agent.permission_decided` |
| `tool.completed` | `run.agent.tool_result` |
| `turn.completed` | `run.agent.result` |

也可以直接使用纯函数：

```ts
import { toAgentHubRuntimeEvents } from "@tokendance/code-sdk";

const mapped = toAgentHubRuntimeEvents(tdEvent);
```

### AgentHub `agent.stream` payload

如果 AgentHub 需要直接复用 Hub 文档中的 `agent.stream` payload 形态，可以用 `createAgentHubAgentStreamSink()`：

```ts
import { createAgentHubAgentStreamSink } from "@tokendance/code-sdk";

const client = new TokenDanceCode({
  eventSink: createAgentHubAgentStreamSink(
    {
      taskId: "task_01HX...",
      edgeRunId: "edge_run_01HX...",
      sessionId: "sess_01HX...",
      agentInstanceId: "agent_01HX..."
    },
    async (payload) => {
      await hubClient.postAgentStream(payload);
    }
  )
});
```

输出 payload 字段对齐 AgentHub `api/events.md`：

```ts
{
  id: string;
  task_id: string;
  edge_run_id: string;
  session_id: string;
  agent_instance_id: string;
  event_seq: number;
  event_type: "run.agent.text_delta" | "...";
  payload: Record<string, unknown>;
  created_at: string;
}
```

`event_seq` 只对这个 sink 实例递增；如果 AgentHub 有自己的全局 event sequence 或 ID 生成器，可以通过 `idFactory` 和外层 emitter 继续覆盖。

## 6. 审批回调

简单场景可以直接传 `approvalCallback`：

```ts
const client = new TokenDanceCode({
  approvalCallback(request) {
    if (request.tool.name === "write_file" && request.session.cwd.includes("AgentHub")) {
      return true;
    }

    return {
      status: "denied",
      reason: `AgentHub policy denied ${request.tool.name}`
    };
  }
});
```

审批回调只处理 PermissionEngine 判定为 `requires_approval` 的工具。`safe` 模式直接 `denied` 的工具不会通过回调升级；工具执行层自己的硬拒绝规则也不会被回调绕过，例如 PowerShell 高风险命令分类。

### AgentHub 远程审批 Bridge

如果审批要通过 AgentHub UI、Hub API 或 `agent.control permission.decide` 异步返回，可以使用 `createAgentHubApprovalBridge()`：

```ts
import { TokenDanceCode, createAgentHubApprovalBridge } from "@tokendance/code-sdk";

const approvalBridge = createAgentHubApprovalBridge({
  async onRequest(request) {
    await hubClient.createApproval({
      approvalId: request.requestId,
      sessionId: request.sessionId,
      turnId: request.turnId,
      toolName: request.toolName,
      toolRisk: request.toolRisk,
      reason: request.reason,
      input: request.input
    });
  }
});

const client = new TokenDanceCode({
  approvalCallback: approvalBridge.approvalCallback
});

// Hub / Edge 收到人工决策后：
approvalBridge.decide("tool-call-id", "allow", "approved in AgentHub");
approvalBridge.decide("tool-call-id", "deny", "rejected in AgentHub");
```

`approvalCallback` 会在工具执行前等待 `decide()`；等待期间 `pending()` 可读取当前待审批请求快照。`decide()` 找不到对应请求时返回 `false`，便于 AgentHub 忽略重复或过期决策。

## 7. AgentHub 最小集成样例包

`packages/agenthub-example` 是私有 workspace 示例包，用来展示 AgentHub Hub/Edge 侧如何把 SDK、`agent.stream` emitter 和远程审批桥接拼起来。它不是新的稳定边界；正式集成仍应依赖 `@tokendance/code-sdk`。

```ts
import { createAgentHubTokenDanceRunner } from "@tokendance/code-agenthub-example";

const runner = createAgentHubTokenDanceRunner({
  storageRoot: "D:/Code/TokenDance/AgentHub/.tokendance-code",
  async emitAgentStream(payload) {
    await hubClient.postAgentStream(payload);
  },
  async onApprovalRequest(request) {
    await hubClient.createApproval(request);
  }
});

const turn = await runner.run({
  prompt: "summarize this repo",
  workingDirectory: "D:/Code/TokenDance/AgentHub",
  permissionMode: "default",
  taskId: "task_01HX...",
  edgeRunId: "edge_run_01HX...",
  sessionId: "sess_01HX...",
  agentInstanceId: "agent_01HX..."
});

console.log(turn.finalResponse);

// Hub / Edge 收到人工决策后：
runner.decideApproval("tool-call-id", "allow", "approved in AgentHub");
```

样例 runner 每次 `run()` 都会创建一个新的 `TokenDanceCode` client，并用 `createAgentHubAgentStreamSink()` 把 runtime events 投递为递增 `event_seq` 的 `agent.stream` payload。真实 AgentHub 集成可以直接复制这个组合方式，再替换为自己的 Hub client、任务状态和 session 生命周期。

## 8. Resume

```ts
const latest = await client.resume({ storageRoot });
console.log(latest.id);
console.log(latest.recentTranscript);

const byId = await client.resume({ sessionId: "session-id", storageRoot });
```

`resume()` 是 AgentHub 推荐使用的便捷入口；它在未传 `sessionId` 时恢复最新 session，传入 `sessionId` 时恢复指定 session。底层仍保留 `loadLatestThread(storageRoot)` 和 `loadThread(sessionId, storageRoot)`，供需要显式区分 latest/by-id 的调用方使用。

`recentTranscript` 暴露的是过滤后的 JSONL envelope，用于 AgentHub 恢复侧栏、事件列表或继续 thread。完整 transcript 仍以 `.tokendance/sessions/<session-id>/transcript.jsonl` 为事实源。

需要把 transcript 路径展示给 AgentHub UI 或调试面板时，使用 `thread.transcript()`：

```ts
const info = await latest.transcript();

console.log(info.sessionId);
console.log(info.transcriptPath);
console.log(info.eventCount);
```

`transcript()` 返回 `sessionDir`、`transcriptPath`、完整 `eventCount` 和当前 resume 入口带回的 `recentEventCount`，调用方不需要自己拼 `.tokendance/sessions/<session-id>/transcript.jsonl`。

需要给 AgentHub 调试面板、会话侧栏或轻量索引提供 transcript 搜索时，使用 `thread.searchTranscript()`：

```ts
const matches = await latest.searchTranscript("needle", { limit: 10 });

for (const match of matches) {
  console.log(match.seq, match.eventType, match.preview);
}
```

搜索结果包含 `sessionId`、`seq`、`eventType`、`timestamp`、可选 `turnId` 和 `preview`。SDK 会排除 `assistant.completed`、`turn.completed` 这类聚合事件，避免同一段 assistant 文本在源事件和完成事件中重复出现。

需要从 AgentHub 触发 compact 时，可以使用 `client.compact()`：

```ts
const latestCompact = await client.compact({ storageRoot });
const selectedCompact = await client.compact({ sessionId: "session-id", storageRoot });

console.log(latestCompact.path);
console.log(selectedCompact.eventCount);
```

`client.compact()` 先通过同一套 resume 入口定位 latest 或指定 session，再生成 deterministic compact summary；调用方也可以在已持有 `Thread` 时继续使用 `thread.compact()`。

## 9. Config

AgentHub 可以通过 SDK 读取 TokenDanceCode 的有效配置，用于调试面板、启动前检查或把 Hub 侧配置投影给 Edge 运行：

```ts
const info = await client.config({
  projectRoot: "D:/Code/TokenDance/AgentHub",
  homeDir: "D:/Users/operator"
});

console.log(info.config.provider);
console.log(info.config.model);
console.log(info.config.permissionMode);
```

配置来源按 `defaults -> global -> project` 合并。当前支持 JSON 文件：

- global：`<homeDir>/.tokendance/config.json`
- project：`<projectRoot>/.tokendance/config.json`

首版只读取 `provider`、`model`、`permissionMode` 三个白名单字段，忽略 `apiKey`、`token` 等 secret 字段，避免把密钥带入 CLI 输出、文档或 AgentHub 调试事件。

## 10. Task / Todo

AgentHub 可以通过 SDK 管理持久任务和 session 级 todo，而不需要直接依赖 core store。Task 是跨 session 的长期任务图，Todo 是当前 session 或当前任务内的短期执行计划。

```ts
const tasks = client.tasks({
  projectRoot: "D:/Code/TokenDance/AgentHub"
});

const task = await tasks.create({
  title: "Stage 15 E2E",
  description: "Close SDK/CLI acceptance"
});

await tasks.addDependency(task.id, "task-parent");
await tasks.linkSession(task.id, "sess_01HX...");
await tasks.linkWorktree(task.id, "D:/Code/TokenDance/TokenDanceCode/.worktrees/ts-refactor");
await tasks.updateStatus(task.id, "completed");

const todos = client.todos({
  projectRoot: "D:/Code/TokenDance/AgentHub",
  sessionId: "sess_01HX..."
});

const todo = await todos.add({
  text: "Run pnpm verify",
  taskId: task.id
});

await todos.updateStatus(todo.id, "in_progress");
```

Task 写入 `<projectRoot>/.tokendance/tasks/tasks.jsonl` 和可重建的 `<projectRoot>/.tokendance/tasks/task-index.json`。带 `sessionId` 的 Todo 写入 `<projectRoot>/.tokendance/sessions/<sessionId>/todos.json`；未传 `sessionId` 时写入项目级 `<projectRoot>/.tokendance/todos.json`，供 CLI 的 `/todo` 和 `tokendance todo` 使用。

当前 SDK facade 覆盖 `create/list/get/updateStatus/addDependency/linkSession/linkWorktree` 和 `add/list/updateStatus`。CLI 只暴露自用高频操作：list、create/add、doing、done；复杂关联由 SDK 或后续 AgentHub UI 驱动。

## 11. Worktree

AgentHub 可以通过 SDK 管理 TokenDanceCode 的受控 Git worktree 池，用于后续 coding subagent 隔离。当前只提供最小 list/create/remove，不包含 subagent 调度器。

```ts
const worktrees = client.worktrees({
  repositoryRoot: "D:/Code/TokenDance/TokenDanceCode"
});

const created = await worktrees.create({ name: "agenthub-wt" });
console.log(created.branch); // codex/agenthub-wt
console.log(created.path);

await worktrees.remove("agenthub-wt");
```

默认 worktree 根目录是 `<repositoryRoot>/.worktrees`，默认分支名是 `codex/<name>`。`name` 只允许字母、数字、点、下划线和短横线，避免路径穿越和 Windows 文件名风险。

`remove(name)` 会先检查目标 worktree 的 `git status --porcelain`；存在未提交改动时拒绝删除。只有调用方显式传 `remove(name, { discard: true })` 时才会使用 `git worktree remove --force`。CLI 对应 `tokendance worktree remove <name> --discard`。

## 12. Subagents

AgentHub 可以通过 SDK 启动和查看 delegated subagent 结果。首版不是多 Agent 团队系统，而是自用的 bounded delegation：readonly investigator/reviewer 返回 summary 且不报告文件修改；coding subagent 在 managed worktree 中运行，并报告 changed files、diff、validation result。

```ts
const subagents = client.subagents({
  projectRoot: "D:/Code/TokenDance/AgentHub"
});

const review = await subagents.runReadonly({
  agentType: "reviewer",
  prompt: "Inspect SDK boundary"
});

const coding = await subagents.runCoding({
  prompt: "Prepare isolated change",
  worktree: "agenthub-coding"
});

console.log(review.summary);
console.log(coding.worktreePath);
console.log(await subagents.list());
```

Subagent 索引写入 `<projectRoot>/.tokendance/agents/agents.json`，单个 subagent transcript 写入 `<projectRoot>/.tokendance/agents/<agent-id>/transcript.jsonl`。默认 registry 同时暴露 `subagent_run` 和 `subagent_list`；`subagent_run` 是 shell 风险工具，因为 coding 模式会创建 worktree。

## 13. Memory

AgentHub 如果需要把项目约定或用户偏好写入 TokenDanceCode 的上下文来源，可以通过 SDK 管理 project/global memory，不需要直接依赖 core `MemoryStore`：

```ts
const memory = client.memory({
  projectRoot: "D:/Code/TokenDance/AgentHub",
  homeDir: "D:/Users/operator"
});

await memory.add("project", "Use pnpm verify before merging.");
await memory.add("global", "Prefer concise status updates.");

console.log(await memory.list("project"));

await memory.delete("project", 0);
```

`project` memory 写入 `<projectRoot>/.tokendance/memory/project.md`，`global` memory 写入 `<homeDir>/.tokendance/memory/global.md`。当前只做显式增删查和 ContextBuilder 注入，不做自动抽取、自动改写或隐式上传。

## 14. Tool Facade

AgentHub 如果需要在 UI 或任务编排层触发 TokenDanceCode 已注册工具，可以使用 SDK 的 `client.tools()`，避免直接依赖 core `ToolOrchestrator`：

```ts
const tools = client.tools({
  workingDirectory: "D:/Code/TokenDance/AgentHub",
  permissionMode: "default"
});

const status = await tools.execute("git_status");
const diff = await tools.execute("git_diff", { paths: ["README.md"] });
const review = await tools.execute("git_review");
const metadata = tools.list();
const quality = await tools.execute(
  "quality_gate",
  { command: "pnpm verify", timeout: 120 },
  { permissionMode: "yolo" }
);
```

`tools.list()` 返回不含 executor/parse 函数的工具能力 metadata：`name`、`description`、`risk`、`concurrency`。AgentHub 可以用它渲染调试面板、权限说明或工具开关。

这个 facade 的 `execute()` 返回 core `ToolResult`，用于 AgentHub 调试面板、手动质量门、Git diff/review、worktree 管理工作流和受控工具执行。`quality_gate` 需要显式传入可执行命令；即使用 `yolo` 让质量命令运行，PowerShell 工具层仍会拒绝已知高风险命令。`worktree_create` 和 `worktree_remove` 是 shell 风险工具，默认模式下需要审批或显式 tool facade 覆盖权限。

## 15. 当前测试覆盖

- `packages/sdk/tests/sdk.test.ts` 覆盖 buffered turn、streamed events、多轮 thread、latest/by-id resume、latest/by-id compact、transcript metadata/search、config facade、memory facade、task/todo facade、subagent facade、worktree facade、tool metadata facade、tool execution facade、worktree/subagent tools、审批允许/拒绝、provider env 配置错误、event sink。
- `packages/sdk/tests/approval-bridge.test.ts` 覆盖 AgentHub 远程审批 bridge、pending 快照、allow/deny 决策回填。
- `packages/sdk/tests/agenthub-events.test.ts` 覆盖 `TDCodeEvent` 到 AgentHub `run.agent.*` 的映射、sink 包装和 `agent.stream` payload fixture。
- `packages/agenthub-example/tests/agenthub-runner.test.ts` 覆盖 AgentHub runner 示例、`agent.stream` payload 序列和 emitter 形态。
- `packages/core/tests/*` 覆盖 runtime、permission、provider adapter、file/shell/patch/git/subagent/worktree/tool metadata/context/resume/config/memory/task/todo。

完整验证命令：

```powershell
pnpm verify
```
