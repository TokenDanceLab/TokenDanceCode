import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { TOKEN_DANCE_CODE_PACKAGE } from "../src/index.js";

const workspaceRoot = new URL("../../../", import.meta.url);

describe("package metadata", () => {
  it("keeps public packages ready for AgentHub consumption", async () => {
    const rootPackage = await readJson("package.json");
    const ignore = await readText(".gitignore");
    const license = await readText("LICENSE");

    expect(rootPackage.private).toBe(true);
    expect(rootPackage.license).toBe("MIT");
    expect(rootPackage.scripts?.["pack:dry-run"]).toBe([
      "pnpm --filter @tokendance/code-core pack --dry-run",
      "pnpm --filter @tokendance/code-sdk pack --dry-run",
      "pnpm --filter @tokendance/code-cli pack --dry-run"
    ].join(" && "));
    expect(rootPackage.scripts?.["pack:smoke"]).toBe("node scripts/smoke-tarball-install.mjs");
    expect(rootPackage.scripts?.["pack:check"]).toBe([
      "pnpm build",
      "pnpm pack:dry-run",
      "pnpm pack:smoke"
    ].join(" && "));
    expect(rootPackage.scripts?.["release:next:check"]).toBe([
      "pnpm verify",
      "pnpm pack:check"
    ].join(" && "));
    expect(license).toContain("MIT License");
    expect(ignore).toContain("*.tgz");

    const smokeScript = await readText("scripts/smoke-tarball-install.mjs");
    expect(smokeScript).toContain("@tokendance/code-core");
    expect(smokeScript).toContain("@tokendance/code-sdk");
    expect(smokeScript).toContain("@tokendance/code-cli");

    const publicPackages = [
      { directory: "packages/core", packageJson: await readJson("packages/core/package.json") },
      { directory: "packages/sdk", packageJson: await readJson("packages/sdk/package.json") },
      { directory: "packages/cli", packageJson: await readJson("packages/cli/package.json") }
    ];

    for (const { directory, packageJson } of publicPackages) {
      expect(packageJson.version).toBe(rootPackage.version);
      expect(packageJson.license).toBe("MIT");
      expect(packageJson.repository).toEqual({
        type: "git",
        url: "https://github.com/TokenDanceLab/TokenDanceCode.git",
        directory
      });
      expect(packageJson.homepage).toBe("https://github.com/TokenDanceLab/TokenDanceCode#readme");
      expect(packageJson.bugs).toEqual({ url: "https://github.com/TokenDanceLab/TokenDanceCode/issues" });
      expect(packageJson.publishConfig).toEqual({ access: "public", tag: "next" });
      expect(packageJson.keywords).toEqual(expect.arrayContaining(["tokendance", "agenthub", "coding-agent"]));
      expect(packageJson.files).toEqual(["dist", "README.md"]);
      expect(packageJson.type).toBe("module");
      expect(packageJson.main).toMatch(/^\.\/dist\/.+\.js$/);
      expect(packageJson.types).toMatch(/^\.\/dist\/.+\.d\.ts$/);
      expect(await readText(`${directory}/README.md`)).toContain(packageJson.name);
    }

    const corePackage = publicPackages[0]!.packageJson;
    const sdkPackage = publicPackages[1]!.packageJson;
    const cliPackage = publicPackages[2]!.packageJson;

    expect(corePackage.exports?.["."]).toEqual({ import: "./dist/index.js", types: "./dist/index.d.ts" });
    expect(sdkPackage.exports?.["."]).toEqual({ import: "./dist/index.js", types: "./dist/index.d.ts" });
    expect(cliPackage.bin?.tokendance).toBe("./dist/main.js");
    expect(sdkPackage.dependencies?.["@tokendance/code-core"]).toBe("workspace:*");
    expect(cliPackage.dependencies?.["@tokendance/code-sdk"]).toBe("workspace:*");
  });

  it("exports AgentHub-readable package entrypoint metadata", () => {
    expect(TOKEN_DANCE_CODE_PACKAGE).toEqual({
      version: "0.2.0-ts.0",
      agentHub: {
        sdkContractVersion: "agenthub-sdk.v1",
        agentStreamSchemaVersion: 1,
        features: [
          "runner-options",
          "event-envelope",
          "startup-doctor",
          "session-resume",
          "context-preview",
          "remote-approval",
          "tokendanceid-oidc-login",
          "config-writer",
          "config-validation"
        ]
      },
      packages: {
        core: {
          name: "@tokendance/code-core",
          import: "@tokendance/code-core",
          types: "@tokendance/code-core"
        },
        sdk: {
          name: "@tokendance/code-sdk",
          import: "@tokendance/code-sdk",
          types: "@tokendance/code-sdk"
        },
        cli: {
          name: "@tokendance/code-cli",
          bin: "tokendance"
        }
      },
      verification: {
        test: "pnpm verify",
        package: "pnpm pack:check",
        tarballSmoke: "pnpm pack:smoke",
        prerelease: "pnpm release:next:check"
      }
    });
  });

  it("documents the next prerelease and tarball install gates", async () => {
    const readme = await readText("README.md");
    const roadmap = await readText("docs/TS重构路线图.md");
    const acceptance = await readText("docs/端到端验收清单.md");
    const packageReadmes = await Promise.all([
      readText("packages/core/README.md"),
      readText("packages/sdk/README.md"),
      readText("packages/cli/README.md")
    ]);

    for (const text of [readme, roadmap, acceptance]) {
      expect(text).toContain("pnpm release:next:check");
      expect(text).toContain("pnpm pack:smoke");
      expect(text).toContain("npm publish --tag next");
      expect(text).toContain("不要在检查脚本中执行 npm publish");
    }

    for (const text of [readme, roadmap, acceptance]) {
      expect(text).toContain("Release owner 检查清单");
      expect(text).toContain("AgentHub consumption story");
      expect(text).toContain("Residual risk matrix");
      expect(text).toContain("Manual approval gate");
    }

    for (const text of packageReadmes) {
      expect(text).toContain("Manual approval gate");
      expect(text).toContain("package-local README");
      expect(text).toContain("npm publish --tag next");
    }
  });

  it("keeps TS branch docs aligned with Node packaging and global provider env boundaries", async () => {
    const readme = await readText("README.md");
    const agents = await readText("AGENTS.md");

    expect(agents).toContain("Runtime: Node.js 20.18+");
    expect(agents).toContain("Package manager: pnpm");
    expect(agents).toContain("pnpm release:next:check");
    expect(agents).not.toContain("Runtime: Python");
    expect(agents).not.toContain("python -m pip");

    expect(readme).toContain("OpenAI Responses API、OpenAI Chat Completions API 与 Anthropic-compatible Messages API");
    expect(readme).toContain("TokenDanceCode 默认不读取项目根目录 `.env`");
    expect(readme).not.toContain("当前实现会在启动时读取当前项目根目录的 `.env`");
    expect(readme).not.toContain("正式发布到 PyPI");
    expect(readme).not.toContain("pipx install");
  });
});

async function readJson(path: string): Promise<Record<string, any>> {
  return JSON.parse(await readText(path)) as Record<string, any>;
}

async function readText(path: string): Promise<string> {
  return readFile(new URL(path, workspaceRoot), "utf8");
}
