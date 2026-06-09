# @tokendance/code-sdk

TypeScript SDK for embedding TokenDanceCode in AgentHub and local tools.

The SDK exposes `TokenDanceCode -> Thread -> run() / runStreamed() / context()` plus AgentHub-oriented event sinks, approval bridging, package metadata, transcript helpers, memory/task facades, subagent/worktree facades, tool execution, config, and doctor diagnostics.

## Install

```powershell
pnpm add @tokendance/code-sdk@next
```

## Usage

```ts
import { TOKEN_DANCE_CODE_PACKAGE, TokenDanceCode } from "@tokendance/code-sdk";

console.log(TOKEN_DANCE_CODE_PACKAGE.verification.prerelease);
console.log(TOKEN_DANCE_CODE_PACKAGE.agentHub.features);

const client = new TokenDanceCode();
const doctor = await client.doctor({ projectRoot: process.cwd() });
const thread = client.startThread({ workingDirectory: process.cwd() });
const turn = await thread.run("hello");
console.log(doctor.agentHub.ready, doctor.agentHub.warningChecks);
console.log(turn.finalResponse);

const config = await client.setConfig(
  { provider: "openai-chat-completions", model: "deepseek-v4-pro", permissionMode: "safe" },
  { projectRoot: process.cwd() }
);
console.log(config.config.provider, config.projectConfigPath);
```

AgentHub startup surfaces can use the `doctor-readiness` and `runner-bootstrap` feature flags to detect the compact startup contract. `doctor.agentHub.ready` is the quick go/no-go value; `blockingChecks` and `warningChecks` point back to the detailed Hub and Edge startup check groups.

## Release Baseline

This package is part of the TokenDanceCode `next` prerelease train. Before publishing a prerelease tarball, run from the workspace root:

```powershell
pnpm release:next:check
pnpm pack:smoke
```

`pnpm pack:smoke` installs the packed core, SDK, and CLI tarballs into a temporary project and verifies SDK import, a mock turn, CLI startup, `doctor --json` AgentHub readiness, and `quality --json` structured output. Do not run `npm publish --tag next` from this check; publish is a separate manual release step after review.

Manual approval gate: this package-local README must stay aligned with the root README before any `npm publish --tag next` action. AgentHub should consume this SDK as the stable package surface, using the exported manifest, thread API, event sinks, approval bridge, config, and doctor facades instead of importing core internals.
