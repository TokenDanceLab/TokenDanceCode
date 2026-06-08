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

## 7. Resume

```ts
const latest = await client.loadLatestThread(storageRoot);
console.log(latest.id);
console.log(latest.recentTranscript);

const byId = await client.loadThread("session-id", storageRoot);
```

`recentTranscript` 暴露的是过滤后的 JSONL envelope，用于 AgentHub 恢复侧栏、事件列表或继续 thread。完整 transcript 仍以 `.tokendance/sessions/<session-id>/transcript.jsonl` 为事实源。

## 8. 当前测试覆盖

- `packages/sdk/tests/sdk.test.ts` 覆盖 buffered turn、streamed events、多轮 thread、latest resume、审批允许/拒绝、provider env 配置错误、event sink。
- `packages/sdk/tests/agenthub-events.test.ts` 覆盖 `TDCodeEvent` 到 AgentHub `run.agent.*` 的映射、sink 包装和 `agent.stream` payload fixture。
- `packages/core/tests/*` 覆盖 runtime、permission、provider adapter、file/shell/patch/git/context/resume/memory。

完整验证命令：

```powershell
pnpm verify
```
