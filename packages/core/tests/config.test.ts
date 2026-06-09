import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readTokenDanceConfig, resolveProviderRuntimeEnv, shouldRunProviderIntegration, validateProviderConfig, writeTokenDanceConfig } from "../src/index.js";

describe("TokenDance config", () => {
  it("merges defaults, global config, and project config without secrets", async () => {
    const root = await mkdtemp(join(tmpdir(), "tdcode-config-"));
    const projectRoot = join(root, "repo");
    const homeDir = join(root, "home");
    await mkdir(join(projectRoot, ".tokendance"), { recursive: true });
    await mkdir(join(homeDir, ".tokendance"), { recursive: true });
    await writeFile(
      join(homeDir, ".tokendance", "config.json"),
      JSON.stringify({
        provider: "openai-responses",
        model: "gpt-test",
        permissionMode: "safe",
        apiKey: "must-not-appear"
      }),
      "utf8"
    );
    await writeFile(
      join(projectRoot, ".tokendance", "config.json"),
      JSON.stringify({
        model: "project-model",
        permissionMode: "auto"
      }),
      "utf8"
    );

    const info = await readTokenDanceConfig({ projectRoot, homeDir });

    expect(info.config).toEqual({
      provider: "openai-responses",
      model: "project-model",
      permissionMode: "auto"
    });
    expect(info.sources.map((source) => source.kind)).toEqual(["defaults", "global", "project"]);
    expect(JSON.stringify(info)).not.toContain("must-not-appear");
  });

  it("applies env provider hints without exposing secrets", async () => {
    const root = await mkdtemp(join(tmpdir(), "tdcode-config-"));
    const info = await readTokenDanceConfig({
      projectRoot: root,
      env: {
        ANTHROPIC_API_KEY: "secret-key",
        MODEL_ID: "deepseek-v4-pro",
        TOKENDANCE_PERMISSION_MODE: "safe"
      }
    });

    expect(info.config).toEqual({
      provider: "anthropic-messages",
      model: "deepseek-v4-pro",
      permissionMode: "safe"
    });
    expect(info.sources.map((source) => source.kind)).toEqual(["defaults", "env"]);
    expect(JSON.stringify(info)).not.toContain("secret-key");
  });

  it("accepts explicit OpenAI Chat Completions provider config", async () => {
    const root = await mkdtemp(join(tmpdir(), "tdcode-config-"));
    const projectRoot = join(root, "repo");
    await mkdir(join(projectRoot, ".tokendance"), { recursive: true });
    await writeFile(
      join(projectRoot, ".tokendance", "config.json"),
      JSON.stringify({ provider: "openai-chat-completions", model: "gpt-chat-test", permissionMode: "safe" }),
      "utf8"
    );

    const info = await readTokenDanceConfig({ projectRoot, homeDir: join(root, "home") });

    expect(info.config).toEqual({
      provider: "openai-chat-completions",
      model: "gpt-chat-test",
      permissionMode: "safe"
    });
  });

  it("derives OpenAI Chat Completions from TokenDance Gateway env", async () => {
    const root = await mkdtemp(join(tmpdir(), "tdcode-config-"));
    const info = await readTokenDanceConfig({
      projectRoot: root,
      env: {
        TOKENDANCE_GATEWAY_API_KEY: "gateway-secret",
        TOKENDANCE_MODEL: "deepseek-v4-pro"
      }
    });

    expect(info.config).toEqual({
      provider: "openai-chat-completions",
      model: "deepseek-v4-pro",
      permissionMode: "default"
    });
    expect(JSON.stringify(info)).not.toContain("gateway-secret");
  });

  it("keeps TokenDance Gateway credentials scoped to OpenAI Chat Completions", () => {
    const env = {
      TOKENDANCE_GATEWAY_API_KEY: "gateway-secret",
      TOKENDANCE_GATEWAY_BASE_URL: "https://api.vectorcontrol.tech/v1",
      OPENAI_API_KEY: "openai-secret",
      OPENAI_BASE_URL: "https://api.openai.example/v1"
    };

    expect(resolveProviderRuntimeEnv("openai-chat-completions", env)).toEqual({
      apiKey: "gateway-secret",
      apiKeyEnv: "TOKENDANCE_GATEWAY_API_KEY",
      baseUrl: "https://api.vectorcontrol.tech/v1",
      baseUrlEnv: "TOKENDANCE_GATEWAY_BASE_URL"
    });
    expect(resolveProviderRuntimeEnv("openai-responses", env)).toEqual({
      apiKey: "openai-secret",
      apiKeyEnv: "OPENAI_API_KEY",
      baseUrl: "https://api.openai.example/v1",
      baseUrlEnv: "OPENAI_BASE_URL"
    });
  });

  it("falls back to OpenAI credentials for explicit Chat Completions providers", () => {
    expect(
      resolveProviderRuntimeEnv("openai-chat-completions", {
        OPENAI_API_KEY: "openai-secret",
        OPENAI_BASE_URL: "https://api.openai.example/v1"
      })
    ).toEqual({
      apiKey: "openai-secret",
      apiKeyEnv: "OPENAI_API_KEY",
      baseUrl: "https://api.openai.example/v1",
      baseUrlEnv: "OPENAI_BASE_URL"
    });
  });

  it("requires explicit integration-test gates for each real provider protocol", () => {
    expect(shouldRunProviderIntegration("openai-responses", {})).toEqual({
      enabled: false,
      missing: ["TOKENDANCE_RUN_MODEL_INTEGRATION=1", "OPENAI_API_KEY", "TOKENDANCE_OPENAI_RESPONSES_TEST_MODEL"]
    });
    expect(
      shouldRunProviderIntegration("openai-chat-completions", {
        TOKENDANCE_RUN_MODEL_INTEGRATION: "1",
        TOKENDANCE_GATEWAY_API_KEY: "gateway-secret",
        TOKENDANCE_OPENAI_CHAT_TEST_MODEL: "deepseek-v4-pro"
      })
    ).toEqual({ enabled: true, missing: [] });
    expect(
      shouldRunProviderIntegration("anthropic-messages", {
        TOKENDANCE_RUN_MODEL_INTEGRATION: "1",
        ANTHROPIC_API_KEY: "anthropic-secret",
        TOKENDANCE_ANTHROPIC_TEST_MODEL: "claude-test"
      })
    ).toEqual({ enabled: true, missing: [] });
  });

  it("validates provider readiness without exposing secrets", () => {
    expect(validateProviderConfig({ provider: "mock", model: "mock", permissionMode: "default" }, {})).toEqual({
      ready: true,
      provider: "mock",
      model: "mock",
      missing: [],
      credentials: {
        apiKey: "not-required"
      },
      baseUrl: {
        status: "not-required"
      }
    });

    expect(validateProviderConfig({ provider: "openai-responses", model: "gpt-test", permissionMode: "safe" }, {})).toEqual({
      ready: false,
      provider: "openai-responses",
      model: "gpt-test",
      missing: ["OPENAI_API_KEY"],
      credentials: {
        apiKey: "missing",
        required: ["OPENAI_API_KEY"]
      },
      baseUrl: {
        status: "default",
        defaultUrl: "https://api.openai.com/v1"
      }
    });

    expect(
      validateProviderConfig(
        { provider: "openai-chat-completions", model: "deepseek-v4-pro", permissionMode: "safe" },
        {
          TOKENDANCE_GATEWAY_API_KEY: "gateway-secret",
          TOKENDANCE_GATEWAY_BASE_URL: "https://api.vectorcontrol.tech/v1"
        }
      )
    ).toEqual({
      ready: true,
      provider: "openai-chat-completions",
      model: "deepseek-v4-pro",
      missing: [],
      credentials: {
        apiKey: "present",
        apiKeyEnv: "TOKENDANCE_GATEWAY_API_KEY",
        required: ["TOKENDANCE_GATEWAY_API_KEY", "OPENAI_API_KEY"]
      },
      baseUrl: {
        status: "present",
        baseUrlEnv: "TOKENDANCE_GATEWAY_BASE_URL"
      }
    });

    const serialized = JSON.stringify(
      validateProviderConfig(
        { provider: "openai-chat-completions", model: "deepseek-v4-pro", permissionMode: "safe" },
        { TOKENDANCE_GATEWAY_API_KEY: "gateway-secret" }
      )
    );
    expect(serialized).not.toContain("gateway-secret");
  });

  it("requires a non-mock model for real provider readiness", () => {
    expect(validateProviderConfig({ provider: "anthropic-messages", model: "mock", permissionMode: "safe" }, { ANTHROPIC_API_KEY: "secret" })).toMatchObject({
      ready: false,
      missing: ["model"]
    });
  });

  it("writes only safe project config fields and strips stored secrets", async () => {
    const root = await mkdtemp(join(tmpdir(), "tdcode-config-write-"));
    const projectRoot = join(root, "repo");
    const homeDir = join(root, "home");
    await mkdir(join(projectRoot, ".tokendance"), { recursive: true });
    await writeFile(
      join(projectRoot, ".tokendance", "config.json"),
      JSON.stringify({
        provider: "openai-responses",
        model: "old-model",
        permissionMode: "default",
        apiKey: "must-be-removed"
      }),
      "utf8"
    );

    const info = await writeTokenDanceConfig({
      projectRoot,
      homeDir,
      scope: "project",
      config: {
        provider: "anthropic-messages",
        model: "claude-test",
        permissionMode: "safe"
      }
    });

    const written = await readFile(join(projectRoot, ".tokendance", "config.json"), "utf8");
    expect(JSON.parse(written)).toEqual({
      provider: "anthropic-messages",
      model: "claude-test",
      permissionMode: "safe"
    });
    expect(written).not.toContain("must-be-removed");
    expect(info.config).toEqual({
      provider: "anthropic-messages",
      model: "claude-test",
      permissionMode: "safe"
    });
    expect(info.sources.map((source) => source.kind)).toEqual(["defaults", "project"]);
  });

  it("can write global config without touching project config", async () => {
    const root = await mkdtemp(join(tmpdir(), "tdcode-config-write-"));
    const projectRoot = join(root, "repo");
    const homeDir = join(root, "home");
    await mkdir(join(projectRoot, ".tokendance"), { recursive: true });
    await writeFile(join(projectRoot, ".tokendance", "config.json"), JSON.stringify({ model: "project-model" }), "utf8");

    const info = await writeTokenDanceConfig({
      projectRoot,
      homeDir,
      scope: "global",
      config: {
        provider: "openai-chat-completions",
        model: "global-model",
        permissionMode: "auto"
      }
    });

    expect(JSON.parse(await readFile(join(homeDir, ".tokendance", "config.json"), "utf8"))).toEqual({
      provider: "openai-chat-completions",
      model: "global-model",
      permissionMode: "auto"
    });
    expect(JSON.parse(await readFile(join(projectRoot, ".tokendance", "config.json"), "utf8"))).toEqual({ model: "project-model" });
    expect(info.config).toEqual({
      provider: "openai-chat-completions",
      model: "project-model",
      permissionMode: "auto"
    });
    expect(info.sources.map((source) => source.kind)).toEqual(["defaults", "global", "project"]);
  });
});
