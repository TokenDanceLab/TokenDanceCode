import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readTokenDanceConfig } from "../src/index.js";

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
});
