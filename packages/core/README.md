# @tokendance/code-core

Core runtime package for TokenDanceCode.

This package owns session state, runtime events, tool orchestration, permission decisions, transcript storage, memory/task helpers, worktree helpers, and provider adapters. It is published so the SDK and CLI can share the same runtime contract; most applications should consume `@tokendance/code-sdk` instead of importing core internals directly.

## Provider Hardening

Core exposes provider adapters for OpenAI Responses, OpenAI Chat Completions / TokenDance Gateway, and Anthropic-compatible Messages. Runtime env resolution keeps credential planes paired with their own base URL variables:

| Provider | API key precedence | Base URL precedence |
|---|---|---|
| `openai-responses` | `OPENAI_API_KEY` | `OPENAI_BASE_URL`, default `https://api.openai.com/v1` |
| `openai-chat-completions` with Gateway key | `TOKENDANCE_GATEWAY_API_KEY` | `TOKENDANCE_GATEWAY_BASE_URL`, default `https://api.vectorcontrol.tech/v1` |
| `openai-chat-completions` with OpenAI fallback key | `OPENAI_API_KEY` | `OPENAI_BASE_URL`, default `https://api.openai.com/v1` |
| `anthropic-messages` | `ANTHROPIC_API_KEY` | `ANTHROPIC_BASE_URL`, default `https://api.anthropic.com` |

Do not mix TokenDance Gateway base URLs with OpenAI fallback keys or OpenAI base URLs with TokenDance Gateway keys. TokenDance Gateway model calls use a TokenDance API key; TokenDanceID/OIDC tokens belong to the identity/session plane and must not be passed as model API keys.

Provider HTTP failures and malformed successful payloads are normalized as `ProviderApiError` without secret values. Unit tests use mocked `fetch` implementations only. Any live provider integration must stay skipped unless `TOKENDANCE_RUN_MODEL_INTEGRATION=1`, the matching API key, and the matching test model env are all present:

| Provider | Test model env |
|---|---|
| `openai-responses` | `TOKENDANCE_OPENAI_RESPONSES_TEST_MODEL` |
| `openai-chat-completions` | `TOKENDANCE_OPENAI_CHAT_TEST_MODEL` |
| `anthropic-messages` | `TOKENDANCE_ANTHROPIC_TEST_MODEL` |

## Install

```powershell
pnpm add @tokendance/code-core@next
```

## Release Baseline

This package is part of the TokenDanceCode `next` prerelease train. Before publishing a prerelease tarball, run from the workspace root:

```powershell
pnpm release:next:check
pnpm pack:smoke
```

`pnpm pack:smoke` installs the packed core, SDK, and CLI tarballs into a temporary project and verifies SDK import plus CLI bin startup. Do not run `npm publish --tag next` from this check; publish is a separate manual release step after review.
