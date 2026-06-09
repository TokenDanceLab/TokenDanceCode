# AgentHub Example

`@tokendance/code-agenthub-example` is a private workspace package for copying AgentHub integration patterns into Hub, Edge, Desktop, or Web shells. It is not a public package and should not be published.

Use `createAgentHubTokenDanceRunner()` when you want the smallest wrapper around `@tokendance/code-sdk`:

```ts
import { createAgentHubTokenDanceRunner } from "@tokendance/code-agenthub-example";

const runner = createAgentHubTokenDanceRunner({
  storageRoot: ".tokendance-code",
  async emitAgentStream(payload) {
    await hubClient.postAgentStream(payload);
  },
  async onApprovalRequest(request) {
    await hubClient.createApproval(request);
  }
});

await runner.run({
  prompt: "summarize this repo",
  workingDirectory: process.cwd(),
  taskId: "task_01",
  edgeRunId: "edge_run_01",
  sessionId: "sess_01",
  agentInstanceId: "agent_01"
});
```

Use `createAgentHubTokenDanceE2EFixture()` when you need a copyable local fixture for tests or demos. It creates the runner, collects emitted `agent.stream` payloads, records remote approval requests, exposes runner `bootstrap()` output, and forwards TokenDanceID login callback helpers.

```ts
import { createAgentHubTokenDanceE2EFixture } from "@tokendance/code-agenthub-example";

const fixture = createAgentHubTokenDanceE2EFixture({
  storageRoot: ".tokendance-code",
  defaultRun: {
    workingDirectory: process.cwd(),
    taskId: "task_01",
    edgeRunId: "edge_run_01",
    sessionId: "sess_01",
    agentInstanceId: "agent_01"
  },
  defaultLogin: {
    clientId: "agenthub-local",
    redirectUri: "http://127.0.0.1:48731/callback",
    deviceType: "desktop"
  }
});

const startup = await fixture.bootstrap({ workingDirectory: process.cwd() });
const login = fixture.createTokenDanceIdLogin({ state: "state-for-test" });
await fixture.run({ prompt: "write a status summary" });

console.log(startup.packageInfo.agentHub.sdkContractVersion);
console.log(startup.doctor.agentHub.ready);
console.log(startup.doctor.agentHub.warningChecks);
console.log(login.authorizationUrl);
console.log(fixture.agentStream.map((event) => event.event_type));
console.log(fixture.approvalRequests);
```

Production AgentHub code should copy the pattern and replace the fixture arrays with its own event bus, approval store, startup checks, and Hub-local TokenDanceID session exchange. Do not save TokenDanceID access or refresh tokens in this runner, and do not use TokenDanceID tokens as TokenDance Gateway model API keys.
