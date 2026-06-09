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
| `provider` | 可传入已有 `ModelProvider`，或 `{ type: "mock" }`、`{ type: "openai-responses", model }`、`{ type: "openai-chat-completions", model }`、`{ type: "anthropic-messages", model }`。 |
| `storageRoot` | transcript/session 写入根目录。未传时使用 thread 的 working directory。 |
| `env` | SDK 内部构造 provider 时读取 API key；用于 AgentHub 注入进程环境或受控配置。 |
| `approvalCallback` | 当权限决策为 `requires_approval` 时调用。返回 `true` 允许，`false` 拒绝，也可返回完整 `PermissionDecision`。 |
| `eventSink` | 每个 runtime event 写入 transcript 后同步推给 AgentHub。 |

真实 provider 的 key 名：

- OpenAI Responses：`OPENAI_API_KEY`
- OpenAI Chat Completions：`OPENAI_API_KEY`
- Anthropic-compatible Messages：`ANTHROPIC_API_KEY`

不要把 API key 写入项目文档或 transcript 示例。

TokenDance Gateway 可作为 OpenAI-compatible provider 接入：

```ts
const client = new TokenDanceCode({
  provider: {
    type: "openai-chat-completions",
    model: "deepseek-v4-pro",
    baseUrl: "https://api.vectorcontrol.tech/v1"
  },
  env: {
    OPENAI_API_KEY: process.env.TOKENDANCE_GATEWAY_API_KEY
  }
});
```

这里的 key 是 TokenDance API key，用于模型 API 调用。TokenDanceID/OIDC 登录应由 AgentHub Hub Server 或产品登录层交换为 Hub-local session；不要把 TokenDanceID access token 传给 Gateway 作为模型 API key。

CLI 侧可用 `tokendance gateway init --model deepseek-v4-pro` 写入全局 `~/.tokendance/.env` preset。该命令只写 provider/model/base URL，不生成、不覆盖、不打印 `TOKENDANCE_GATEWAY_API_KEY`。

## 3. 包入口与验证元信息

AgentHub 如果需要在启动检查、调试面板或集成日志里展示 TokenDanceCode 包信息，可以直接读取 SDK 导出的只读 manifest，而不是解析 workspace `package.json`：

```ts
import { TOKEN_DANCE_CODE_PACKAGE } from "@tokendance/code-sdk";

console.log(TOKEN_DANCE_CODE_PACKAGE.version);
console.log(TOKEN_DANCE_CODE_PACKAGE.packages.sdk.import);
console.log(TOKEN_DANCE_CODE_PACKAGE.packages.cli.bin);
console.log(TOKEN_DANCE_CODE_PACKAGE.agentHub.sdkContractVersion);
console.log(TOKEN_DANCE_CODE_PACKAGE.agentHub.agentStreamSchemaVersion);
console.log(TOKEN_DANCE_CODE_PACKAGE.verification.package);
console.log(TOKEN_DANCE_CODE_PACKAGE.verification.tarballSmoke);
console.log(TOKEN_DANCE_CODE_PACKAGE.verification.prerelease);
```

当前 manifest 覆盖 core/sdk/cli 包名、SDK/Core import specifier、CLI bin 名、AgentHub SDK contract version、`agent.stream` schema version、SDK feature flags 和推荐验证命令：`pnpm verify`、`pnpm pack:check`、`pnpm pack:smoke`、`pnpm release:next:check`。它不包含本机路径、密钥或 workspace 私有路径，适合进入 AgentHub UI 或日志。AgentHub Hub/Edge 启动检查可以把 `agentHub.sdkContractVersion === "agenthub-sdk.v1"` 和 `agentHub.agentStreamSchemaVersion === 1` 当作当前稳定契约的快速断言。

## 4. TokenDanceID OIDC 登录启动

SDK 提供轻量 TokenDanceID OIDC helper，帮助 AgentHub Hub/Desktop/Web 或本地壳层启动 Authorization Code + PKCE S256 登录流。它只生成登录 URL、`state`、`nonce`、`codeVerifier` 并校验 callback state；不交换 authorization code、不验证 ID token、不保存 access/refresh token。

AgentHub Hub Server 仍然负责 code exchange、JWKS/issuer/audience/expiration 验证、`tokendance_sub` 映射和 Hub-local session 签发。

```ts
import { createTokenDanceIdLoginRequest, verifyTokenDanceIdCallback } from "@tokendance/code-sdk";

const login = createTokenDanceIdLoginRequest({
  clientId: "agenthub-local",
  redirectUri: "http://127.0.0.1:48731/callback",
  extraParams: {
    device_type: "desktop",
    device_id: "00000000-0000-4000-8000-000000000001"
  }
});

openSystemBrowser(login.authorizationUrl);

const callback = verifyTokenDanceIdCallback(callbackUrlFromLoopbackServer, login);

await hub.exchangeTokenDanceIdCode({
  code: callback.code,
  codeVerifier: callback.codeVerifier,
  redirectUri: callback.redirectUri
});
```

默认 issuer 是 `https://id.vectorcontrol.tech`，默认 scope 是 `openid profile email`。Desktop/native 场景应使用 TokenDanceID 已登记的 loopback callback 策略；生产 Hub/Web 场景应使用 Hub-owned backend callback。TokenDanceID/OIDC 登录 token 只用于身份和 Hub session，不是 TokenDance Gateway 模型 API key。

CLI 使用同一 helper 暴露调试入口：

```powershell
tokendance auth tokendanceid login-url `
  --client-id agenthub-local `
  --redirect-uri http://127.0.0.1:48731/callback `
  --device-type desktop `
  --device-id 00000000-0000-4000-8000-000000000001 `
  --json
```

`--json` 输出适合 AgentHub 调试面板或 Desktop shell 读取；纯文本输出适合人工复制。CLI 不会打开浏览器、不写入本地 token 文件，也不会把 TokenDanceID 登录 token 当作 TokenDance Gateway 模型 API key。

## 5. 启动 Thread

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

`thread.state` 返回当前 session 的只读快照副本，方便 AgentHub 做侧栏、调试面板或持久化索引。不要修改这个快照后再期待影响 SDK 内部状态；后续运行仍应通过 `thread.run()` 或 `thread.runStreamed()`。Runtime 会在每轮 provider 调用前构造 transient context，把 system prompt、AGENTS/CLAUDE/README、compact summary、memory 和 recent messages 送给模型；`thread.state.messages` 仍只保存真实会话消息，不包含 system context。

AgentHub 如果需要在调试面板或运行预览里展示下一轮模型上下文，可以用同源 context builder：

```ts
const preview = await thread.context("next prompt");
console.log(preview.includedFiles);
console.log(preview.messages[0]?.content);

const shortPreview = await thread.context("next prompt", {
  maxRecentMessages: 6
});
```

`thread.context()` 只返回 transient preview，不会把本轮 user message 或 system context 写入 `thread.state`、session 文件或 transcript。`maxRecentMessages` 可限制 preview 中带入的历史消息数量，供 AgentHub resume 面板、运行前调试或低上下文预算场景使用；不传时保持默认最近 20 条消息。

## 6. 流式事件

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

## 7. AgentHub Runtime Event 映射

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
  schema_version: 1;
  sdk_contract_version: "agenthub-sdk.v1";
  source: "tokendance-code-sdk";
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

`schema_version`、`sdk_contract_version` 和 `source` 是稳定 envelope 字段，方便 Hub/Edge 在启动检查、事件落库和前端调试中快速区分 SDK 契约版本。`event_seq` 只对这个 sink 实例递增；如果 AgentHub 有自己的全局 event sequence 或 ID 生成器，可以通过 `idFactory` 和外层 emitter 继续覆盖。

## 8. 审批回调

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

审批回调只处理 PermissionEngine 判定为 `requires_approval` 的工具。`safe` 模式直接 `denied` 的工具不会通过回调升级；工具执行层自己的硬拒绝规则也不会被回调绕过，例如 PowerShell 高风险命令分类。权限原因统一包含 `mode=<mode> tool=<name> risk=<risk> action=<allowed|approval_required|denied>` 前缀，便于 AgentHub UI、日志和 transcript 直接展示同一份可审计原因。

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

`approvalCallback` 会在工具执行前等待 `decide()`；等待期间 `pending()` 可读取当前待审批请求快照。`decide()` 找不到对应请求时返回 `false`，便于 AgentHub 忽略重复或过期决策。同一个 tool call id 如果重复进入 bridge，首个请求继续使用原 id，后续请求会追加 `#2`、`#3` 等后缀作为独立 `requestId`，原始 call id 保留在 `callId`。如果 `onRequest` 发布到 Hub 失败，bridge 会清理 pending 项并返回 `denied`，避免 runtime 永久等待。

被拒绝的工具结果会在 `tool.completed` 事件中携带 `safetyEvidence`：权限引擎拒绝使用 `source: "permission_engine"`，PowerShell 硬拒绝使用 `source: "powershell_classifier"`。这份结果会随 transcript 持久化，供 AgentHub 回放拒绝证据。

## 9. AgentHub 最小集成样例包

`packages/agenthub-example` 是私有 workspace 示例包，用来展示 AgentHub Hub/Edge 侧如何把 SDK、`agent.stream` emitter、远程审批、启动检查和 TokenDanceID 登录 facade 拼起来。它不是新的稳定边界；正式集成仍应依赖 `@tokendance/code-sdk`，并把样例里的数组收集器替换成自己的 Hub event bus、审批存储和 session 生命周期。

```ts
import { createAgentHubTokenDanceRunner } from "@tokendance/code-agenthub-example";

const runner = createAgentHubTokenDanceRunner({
  storageRoot: "D:/Code/TokenDance/AgentHub/.tokendance-code",
  defaultPermissionMode: "default",
  contextMaxRecentMessages: 20,
  streamIdFactory(eventSeq, event) {
    return `agenthub_${event.eventType}_${eventSeq}`;
  },
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

const preview = await runner.context({
  prompt: "preview the next turn",
  workingDirectory: "D:/Code/TokenDance/AgentHub",
  permissionMode: "default",
  sessionId: "sess_01HX..."
});

console.log(preview.includedFiles);

const packageInfo = runner.packageInfo();
const doctor = await runner.doctor({
  workingDirectory: "D:/Code/TokenDance/AgentHub"
});

console.log(packageInfo.packages.sdk.name);
console.log(doctor.stateDir.writable);
console.log(doctor.startup.hub.ok);
console.log(doctor.startup.edge.ok);

// Hub / Edge 收到人工决策后：
console.log(runner.pendingApprovals());
runner.decideApproval("tool-call-id", "allow", "approved in AgentHub");

const login = runner.createTokenDanceIdLogin({
  clientId: "agenthub-local",
  redirectUri: "http://127.0.0.1:48731/callback",
  deviceType: "desktop",
  deviceId: "00000000-0000-4000-8000-000000000001"
});

openSystemBrowser(login.authorizationUrl);

const callback = runner.verifyTokenDanceIdCallback(callbackUrlFromLoopbackServer, login);

await hub.exchangeTokenDanceIdCode({
  code: callback.code,
  codeVerifier: callback.codeVerifier,
  redirectUri: callback.redirectUri
});
```

需要写 AgentHub 集成测试或本地 demo 时，可以使用同一私有包里的 e2e fixture。它仍然只组合样例 runner，不复制 SDK runtime 内部逻辑：

```ts
import { createAgentHubTokenDanceE2EFixture } from "@tokendance/code-agenthub-example";

const fixture = createAgentHubTokenDanceE2EFixture({
  storageRoot: "D:/Code/TokenDance/AgentHub/.tokendance-code",
  defaultRun: {
    workingDirectory: "D:/Code/TokenDance/AgentHub",
    taskId: "task_01HX...",
    edgeRunId: "edge_run_01HX...",
    sessionId: "sess_01HX...",
    agentInstanceId: "agent_01HX..."
  },
  defaultLogin: {
    clientId: "agenthub-local",
    redirectUri: "http://127.0.0.1:48731/callback",
    deviceType: "desktop"
  },
  async onAgentStream(payload) {
    await hubClient.postAgentStream(payload);
  },
  async onApprovalRequest(request) {
    await hubClient.createApproval(request);
  }
});

const startup = await fixture.bootstrap({
  workingDirectory: "D:/Code/TokenDance/AgentHub"
});
const login = fixture.createTokenDanceIdLogin({
  state: "state-from-agenthub-shell"
});

const turnPromise = fixture.run({
  prompt: "summarize this repo",
  permissionMode: "default"
});

console.log(startup.packageInfo.agentHub.sdkContractVersion);
console.log(startup.doctor.startup.hub.ok);
console.log(login.authorizationUrl);
console.log(fixture.agentStream);
console.log(fixture.approvalRequests);

fixture.decideApproval("tool-call-id", "allow", "approved in AgentHub");
await turnPromise;
```

样例 runner 每次 `run()` 都会创建一个新的 `TokenDanceCode` client，并用同一套 AgentHub stream envelope helper 把 runtime events 投递为递增 `event_seq` 的 `agent.stream` payload。传入的 AgentHub `sessionId` 会同时作为 TokenDanceCode thread id 使用；runner 会先按该 id `resume()`，没有现存 session 时才 `startThread()`，保证 Hub 事件、SDK `TurnResult.threadId`、provider 可见的消息历史和 transcript 目录使用同一个 session 标识。`defaultPermissionMode` 只作用于新建 thread；已存在 session 继续使用 session 内保存的权限模式。`streamIdFactory` 可接管 `agent.stream.id` 生成，`contextMaxRecentMessages` 可作为 runner 级 preview 历史上限，单次 `runner.context({ maxRecentMessages })` 可以覆盖该默认值。`runner.context()` 复用同一条按 Hub `sessionId` resume-or-start 的路径，返回下一轮 transient provider context preview；它不会发出 `agent.stream` 事件，也不会把 preview prompt 或 system context 追加进 transcript。`packageInfo()` 和 `doctor()` 只是把 SDK manifest/doctor facade 暴露给 Hub/Edge 启动检查，真实 AgentHub 集成可以直接复制这个组合方式，再替换为自己的 Hub client、任务状态和 session 生命周期。

当 runner 配置了 `onApprovalRequest` 时，远程审批请求会先发出 `run.agent.permission_requested` envelope，再等待 Hub/Edge 调用 `runner.decideApproval()`。决策返回后，runtime 会继续发出 `run.agent.permission_decided`、`run.agent.tool_result` 和最终结果事件。`pendingApprovals()` 返回待处理请求快照；`decideApproval()` 对重复、过期或未知 request id 返回 `false`。

`createTokenDanceIdLogin()` 和 `verifyTokenDanceIdCallback()` 是对 SDK TokenDanceID helper 的样例层封装，便于 AgentHub Desktop/Web shell 或调试面板复用同一套 PKCE S256 URL 生成与 callback `state` 校验。runner 只返回 `code`、`codeVerifier` 和 `redirectUri` 给 Hub；Hub Server 仍拥有 authorization code exchange、JWKS/issuer/audience/expiration 验证、`tokendance_sub` 映射和 Hub-local session 签发。不要在 runner 或 shell 中保存 TokenDanceID access/refresh token，也不要把 TokenDanceID token 当作 TokenDance Gateway 模型 API key。

`createAgentHubTokenDanceE2EFixture()` 适合复制到 AgentHub 测试夹具：`defaultRun` 提供 `workingDirectory/taskId/edgeRunId/sessionId/agentInstanceId` 默认值，`run()` 和 `context()` 可按单次调用覆盖；`defaultLogin` 提供 TokenDanceID shell 默认参数；`agentStream` 和 `approvalRequests` 保存已捕获 payload，便于断言事件顺序和远程审批状态；`bootstrap()` 一次返回 `packageInfo()` 和 `doctor()`，用于 Hub/Edge 启动检查。生产代码应把这些收集器替换为真实落库和广播，不应把 `@tokendance/code-agenthub-example` 发布或作为 public npm contract。

## 10. Resume

```ts
const latest = await client.resume({ storageRoot });
console.log(latest.id);
console.log(latest.recentTranscript);

const byId = await client.resume({ sessionId: "session-id", storageRoot });
```

`resume()` 是 AgentHub 推荐使用的便捷入口；它在未传 `sessionId` 时恢复最新 session，传入 `sessionId` 时恢复指定 session。恢复后的 thread 会继续使用同一份 session state 和 JSONL transcript，后续 turn 的 transcript `seq` 会接着历史事件递增。底层仍保留 `loadLatestThread(storageRoot)` 和 `loadThread(sessionId, storageRoot)`，供需要显式区分 latest/by-id 的调用方使用。

`recentTranscript` 暴露的是过滤后的 JSONL envelope，用于 AgentHub 恢复侧栏、事件列表或继续 thread。完整 transcript 仍以 `.tokendance/sessions/<session-id>/transcript.jsonl` 为事实源。

需要给 AgentHub 会话侧栏、调试面板或轻量索引列出可恢复 session 时，使用只读 `client.sessions().list()`：

```ts
const sessions = await client.sessions({ storageRoot }).list();

for (const session of sessions) {
  console.log(session.sessionId, session.latest, session.eventCount);
  console.log(session.sessionDir);
  console.log(session.transcriptPath);
}
```

每条记录包含 `sessionId`、`sessionDir`、`transcriptPath`、`createdAt`、`updatedAt`、`eventCount`、可选 `lastEventTimestamp` 和 `latest` 标记。该 facade 只读取 session/transcript 文件，不写入 session state，也不改变 transcript schema。

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

## 11. Config

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

AgentHub 需要从设置页或启动向导写入本地 project/global 配置时，使用同一个 SDK facade：

```ts
const saved = await client.setConfig(
  {
    provider: "openai-chat-completions",
    model: "deepseek-v4-pro",
    permissionMode: "safe"
  },
  {
    projectRoot: "D:/Code/TokenDance/AgentHub",
    homeDir: "D:/Users/operator",
    scope: "project"
  }
);

console.log(saved.projectConfigPath);
```

配置来源按 `defaults -> global -> project -> env` 合并。当前支持 JSON 文件：

- global：`<homeDir>/.tokendance/config.json`
- project：`<projectRoot>/.tokendance/config.json`

Config facade 只读写 `provider`、`model`、`permissionMode` 三个白名单字段，忽略并清理 `apiKey`、`token` 等 secret 字段，避免把密钥带入 CLI 输出、文档或 AgentHub 调试事件。调用方通过 SDK `env` 显式注入环境时，`MODEL_ID` / `TOKENDANCE_MODEL` 可设置模型，`TOKENDANCE_PROVIDER` 可显式设置 provider；未显式设置 provider 但存在 `MODEL_ID` 和对应 API key 时，SDK config facade 会把 `ANTHROPIC_API_KEY` 推断为 `anthropic-messages`、把 `OPENAI_API_KEY` 推断为 `openai-responses`。存在 `TOKENDANCE_GATEWAY_API_KEY` 和模型时会推断为 `openai-chat-completions`。需要 OpenAI-compatible `/v1/chat/completions` 时显式设置 `TOKENDANCE_PROVIDER=openai-chat-completions`。密钥只参与 present/missing 和 provider 推断，不会进入 `config()` / `setConfig()` 输出，也不应写入 JSON 配置。

## 12. Doctor

AgentHub 可以通过 SDK 读取和 CLI `doctor` 同源的结构化诊断，用于启动前检查、调试面板或 Edge 环境报告：

```ts
const doctor = await client.doctor({
  projectRoot: "D:/Code/TokenDance/AgentHub",
  homeDir: "D:/Users/operator"
});

console.log(doctor.apiKeys.OPENAI_API_KEY);
console.log(doctor.git.available);
console.log(doctor.powershell.available);
console.log(doctor.config.sources);
console.log(doctor.stateDir.writable);
console.log(doctor.packageInfo.agentHub.sdkContractVersion);
console.log(doctor.startup.hub.ok);
console.log(doctor.startup.edge.ok);
```

`doctor.apiKeys` 只返回 `present`/`missing`，不会返回实际 API key。诊断结果还包括版本、Node、cwd、platform、Git 仓库状态、PowerShell 可用性、config 路径/source、`.tokendance` 状态目录可写性、只读 `packageInfo` manifest，以及 `startup.hub` / `startup.edge` 检查组。Hub 侧当前检查 package manifest、config 可读性和状态目录可写性；Edge 侧当前检查 `agent.stream` envelope 契约、Git 可用性和 PowerShell 可用性。`warn` 级检查不会让 `ok` 变成 `false`；`fail` 代表启动前必须处理的阻断项。

## 13. Task / Todo

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

当前 SDK facade 覆盖 `create/list/get/updateStatus/addDependency/linkSession/linkWorktree` 和 `add/list/updateStatus`。CLI 暴露自用高频操作：list、create/add、doing、done，并支持 `tasks link-session <task-id> <session-id>` 与 `tasks link-worktree <task-id> <worktree>`，方便把长期任务、session transcript 和隔离 worktree 关联成可审计闭环；更复杂的依赖图仍由 SDK 或后续 AgentHub UI 驱动。

## 14. Worktree

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

## 15. Subagents

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
console.log(await subagents.get(coding.id));
console.log(await subagents.list());

await subagents.accept(coding.id, {
  discardWorktree: true
});

const throwaway = await subagents.runCoding({
  prompt: "Try disposable change",
  worktree: "agenthub-throwaway"
});
await subagents.discard(throwaway.id, { discard: true });
```

Subagent 索引写入 `<projectRoot>/.tokendance/agents/agents.json`，单个 subagent transcript 写入 `<projectRoot>/.tokendance/agents/<agent-id>/transcript.jsonl`。`subagents.get(id)` 读取单条记录；`subagents.accept(id)` 会把 coding subagent worktree 的当前 diff 应用回目标仓库并把 run 标记为 `accepted`，目标仓库存在用户可见未提交改动时默认拒绝，避免把 subagent diff 混进脏工作区；只有显式 `accept(id, { allowDirtyTarget: true })` 才覆盖这个保护。`subagents.discard(id)` 会移除 coding subagent 的 managed worktree 并把 run 标记为 `discarded`，dirty worktree 默认拒绝删除，只有显式 `discard(id, { discard: true })` 才会强制丢弃未提交改动。默认 registry 同时暴露 `subagent_run`、`subagent_list`、`subagent_get`、`subagent_accept` 和 `subagent_discard`；`subagent_run`、`subagent_accept` 和 `subagent_discard` 是 shell 风险工具，因为它们会创建、应用或移除 worktree。

## 16. Memory

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

## 17. Tool Facade

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
const autoQuality = await tools.execute(
  "quality_gate",
  {},
  { permissionMode: "yolo" }
);
const quality = await tools.execute(
  "quality_gate",
  { command: "pnpm verify", timeout: 120 },
  { permissionMode: "yolo" }
);
```

`tools.list()` 返回不含 executor/parse 函数的工具能力 metadata：`name`、`description`、`risk`、`concurrency`、各权限模式下的 `permission` 状态，以及工具级 `safetyNotes`。AgentHub 可以用它渲染调试面板、权限说明、拒绝原因预览或工具开关。

这个 facade 的 `execute()` 返回 core `ToolResult`，用于 AgentHub 调试面板、手动质量门、Git diff/review、worktree/subagent 管理工作流和受控工具执行。`quality_gate` 不传 `command` 时会自动发现 `package.json` 的 `verify` 脚本，缺少 `verify` 时回退到 `test`；传入 `command` 时使用显式命令覆盖。即使用 `yolo` 让质量命令运行，PowerShell 工具层仍会拒绝已知高风险命令。`worktree_create`、`worktree_remove`、`subagent_run`、`subagent_accept` 和 `subagent_discard` 是 shell 风险工具，默认模式下需要审批或显式 tool facade 覆盖权限。

## 18. 当前测试覆盖

- `packages/sdk/tests/sdk.test.ts` 覆盖 buffered turn、streamed events、多轮 thread、context preview/history limit、latest/by-id resume、session list facade、latest/by-id compact、transcript metadata/search、config facade、doctor facade/startup checks、memory facade、task/todo facade、subagent facade、worktree facade、tool metadata facade、tool execution facade、worktree/subagent tools、审批允许/拒绝、provider env 配置错误、event sink。
- `packages/sdk/tests/package-metadata.test.ts` 覆盖 public package metadata、`pack:check` 脚本、tarball ignore 规则和 SDK 导出的 AgentHub-readable package manifest。
- `packages/sdk/tests/approval-bridge.test.ts` 覆盖 AgentHub 远程审批 bridge、pending 快照、allow/deny 决策回填。
- `packages/sdk/tests/agenthub-events.test.ts` 覆盖 `TDCodeEvent` 到 AgentHub `run.agent.*` 的映射、sink 包装和 `agent.stream` payload fixture。
- `packages/agenthub-example/tests/agenthub-runner.test.ts` 覆盖 AgentHub runner 示例、e2e fixture、runner options、context preview history limit、远程审批桥接、`agent.stream` payload 序列、emitter 形态、runner package manifest 和 doctor 启动诊断。
- `packages/core/tests/*` 覆盖 runtime、permission、provider adapter、file/shell/patch/git/subagent/worktree/tool metadata/context/resume/config/memory/task/todo。

完整验证命令：

```powershell
pnpm verify
pnpm pack:check
```
