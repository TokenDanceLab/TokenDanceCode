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

const client = new TokenDanceCode();
const thread = client.startThread({ workingDirectory: process.cwd() });
const turn = await thread.run("hello");
console.log(turn.finalResponse);

const config = await client.setConfig(
  { provider: "openai-chat-completions", model: "deepseek-v4-pro", permissionMode: "safe" },
  { projectRoot: process.cwd() }
);
console.log(config.config.provider, config.projectConfigPath);
```

## Release Baseline

This package is part of the TokenDanceCode `next` prerelease train. Before publishing a prerelease tarball, run from the workspace root:

```powershell
pnpm release:next:check
pnpm pack:smoke
```

`pnpm pack:smoke` installs the packed core, SDK, and CLI tarballs into a temporary project and verifies SDK import plus CLI bin startup. Do not run `npm publish --tag next` from this check; publish is a separate manual release step after review.
