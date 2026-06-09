import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { AGENTHUB_FEATURE_FLAGS, TOKEN_DANCE_CODE_PACKAGE, supportsAgentHubFeature } from "../src/index.js";

const workspaceRoot = new URL("../../../", import.meta.url);

describe("package metadata", () => {
  it("keeps public packages ready for AgentHub consumption", async () => {
    const rootPackage = await readJson("package.json");
    const ignore = await readText(".gitignore");
    const envExample = await readText(".env.example");
    const license = await readText("LICENSE");

    expect(rootPackage.private).toBe(true);
    expect(rootPackage.license).toBe("MIT");
    expect(rootPackage.scripts?.["pack:dry-run"]).toBe([
      "pnpm --filter @tokendance/code-core pack --dry-run",
      "pnpm --filter @tokendance/code-sdk pack --dry-run",
      "pnpm --filter @tokendance/code-cli pack --dry-run"
    ].join(" && "));
    expect(rootPackage.scripts?.["pack:smoke"]).toBe("node scripts/smoke-tarball-install.mjs");
    expect(rootPackage.scripts?.["smoke:gateway"]).toBe("node scripts/smoke-real-gateway.mjs");
    expect(rootPackage.scripts?.["registry:next:check"]).toBe("node scripts/check-registry-next.mjs");
    expect(rootPackage.scripts?.["wave4:status"]).toBe("node scripts/verify-wave4-worktrees.mjs");
    expect(rootPackage.scripts?.["wave5:status"]).toBe("node scripts/verify-wave5-worktrees.mjs");
    expect(rootPackage.scripts?.["pack:check"]).toBe([
      "pnpm build",
      "pnpm pack:dry-run",
      "pnpm pack:smoke"
    ].join(" && "));
    expect(rootPackage.scripts?.["contract:check"]).toBe("node scripts/check-release-contract.mjs");
    expect(rootPackage.scripts?.["release:next:check"]).toBe([
      "pnpm contract:check",
      "pnpm verify",
      "pnpm pack:check"
    ].join(" && "));
    expect(license).toContain("MIT License");
    expect(ignore).toContain("*.tgz");
    expect(ignore).toContain(".tmp/");
    expect(envExample).toContain("does not load the repository root .env by default");
    expect(envExample).toContain("~/.tokendance/.env");
    expect(envExample).toContain("TOKENDANCE_GATEWAY_API_KEY=<tokendance-gateway-api-key>");

    const smokeScript = await readText("scripts/smoke-tarball-install.mjs");
    expect(smokeScript).toContain("@tokendance/code-core");
    expect(smokeScript).toContain("@tokendance/code-sdk");
    expect(smokeScript).toContain("@tokendance/code-cli");
    expect(smokeScript).toContain("createAgentHubTokenDanceConsumerFixture");
    expect(smokeScript).toContain("agenthub tarball smoke");
    expect(smokeScript).toContain("doctor --json");
    expect(smokeScript).toContain("quality --json");
    expect(smokeScript).toContain("agentHub.ready");
    expect(smokeScript).toContain("provider-ready");
    expect(smokeScript).toContain("assertNoForbiddenPackageContent");
    expect(smokeScript).toContain("assertPackedManifest");
    expect(smokeScript).toContain("workspace:");
    expect(smokeScript).toContain("bin.tokendance");
    expect(smokeScript).toContain("assertNpmInstallSmoke");
    expect(smokeScript).toContain("npm");
    expect(smokeScript).toContain("package-lock-only=false");
    expect(smokeScript).toContain("Packed package privacy scan failed");
    expect(smokeScript).toContain("sk-[A-Za-z0-9_-]{20,}");
    expect(smokeScript).toContain("github_pat_");
    expect(smokeScript).toContain("npm_[A-Za-z0-9]{20,}");
    expect(smokeScript).toContain("TOKENDANCE_GATEWAY_API_KEY");
    expect(smokeScript).toContain("isSymbolicLink");
    expect(smokeScript).toContain("no scannable package files found");
    expect(smokeScript).not.toContain("overrides");

    const contractScript = await readText("scripts/check-release-contract.mjs");
    expect(contractScript).toContain("assertPackageManifest");
    expect(contractScript).toContain("assertAgentHubContractReadiness");
    expect(contractScript).toContain("assertPackSmokeEntrypoint");
    expect(contractScript).toContain("createAgentHubAgentStreamSink");
    expect(contractScript).toContain("createAgentHubTokenDanceConsumerFixture");
    expect(contractScript).toContain("pnpm pack:smoke");

    const registryScript = await readText("scripts/check-registry-next.mjs");
    expect(registryScript).toContain("npm");
    expect(registryScript).toContain("view");
    expect(registryScript).toContain("E404");
    expect(registryScript).toContain("currentVersion");
    expect(registryScript).toContain("already exists");
    expect(registryScript).not.toContain("npm publish");

    const gatewaySmokeScript = await readText("scripts/smoke-real-gateway.mjs");
    expect(gatewaySmokeScript).toContain("TOKENDANCE_RUN_REAL_PROVIDER_SMOKE");
    expect(gatewaySmokeScript).toContain("TOKENDANCE_GATEWAY_API_KEY");
    expect(gatewaySmokeScript).toContain("TOKENDANCE_GATEWAY_BASE_URL");
    expect(gatewaySmokeScript).toContain("TOKENDANCE_REAL_SMOKE_MODELS");
    expect(gatewaySmokeScript).toContain("doctor");
    expect(gatewaySmokeScript).toContain("config");
    expect(gatewaySmokeScript).toContain("validate");
    expect(gatewaySmokeScript).toContain("run");
    expect(gatewaySmokeScript).toContain("redact");
    expect(gatewaySmokeScript).toMatch(/env\.TOKENDANCE_GATEWAY_API_KEY,\s+env\.TOKENDANCE_GATEWAY_BASE_URL,\s+env\.OPENAI_API_KEY/s);
    expect(gatewaySmokeScript).not.toContain("npm publish");

    const wave4Script = await readText("scripts/verify-wave4-worktrees.mjs");
    expect(wave4Script).toContain("codex/wave4-cli-command-architecture");
    expect(wave4Script).toContain("codex/wave4-sdk-agenthub-consumer-fixture");
    expect(wave4Script).toContain("codex/wave4-tui-interaction-polish");
    expect(wave4Script).toContain("codex/wave4-llm-real-smoke-gates");
    expect(wave4Script).toContain("codex/wave4-permission-policy-audit");
    expect(wave4Script).toContain("codex/wave4-thread-session-lifecycle");
    expect(wave4Script).toContain("82096a6");
    expect(wave4Script).toContain("merge-base");

    const wave5Script = await readText("scripts/verify-wave5-worktrees.mjs");
    expect(wave5Script).toContain("codex/wave5-reference-architecture");
    expect(wave5Script).toContain("codex/wave5-release-npm-baseline");
    expect(wave5Script).toContain("codex/wave5-sdk-agenthub-contract");
    expect(wave5Script).toContain("codex/wave5-agenthub-consumer-fixture");
    expect(wave5Script).toContain("codex/wave5-gateway-quickstart");
    expect(wave5Script).toContain("codex/wave5-tokendanceid-oidc");
    expect(wave5Script).toContain("codex/wave5-provider-hardening");
    expect(wave5Script).toContain("codex/wave5-permission-safety");
    expect(wave5Script).toContain("codex/wave5-cli-tui-polish");
    expect(wave5Script).toContain("codex/wave5-session-subagent");
    expect(wave5Script).toContain("0f631f3");
    expect(wave5Script).toContain("merge-base");

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
        agentStreamSchemaVersion: 2,
        features: [
          "runner-options",
          "event-envelope",
          "startup-doctor",
          "doctor-readiness",
          "runner-bootstrap",
          "agenthub-consumer-fixture",
          "session-resume",
          "session-lifecycle-metadata",
          "context-preview",
          "remote-approval",
          "tokendanceid-oidc-login",
          "config-writer",
          "config-validation",
          "agenthub-package-feature-flags",
          "agenthub-event-envelope-schema",
          "agenthub-approval-bridge",
          "agenthub-doctor-readiness",
          "agenthub-contract-readiness",
          "terminal-failure-result"
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

  it("exports a stable AgentHub feature flag set for contract negotiation", () => {
    expect(AGENTHUB_FEATURE_FLAGS).toEqual(TOKEN_DANCE_CODE_PACKAGE.agentHub.features);
    expect(AGENTHUB_FEATURE_FLAGS).toEqual(
      expect.arrayContaining([
        "agenthub-package-feature-flags",
        "agenthub-event-envelope-schema",
        "agenthub-approval-bridge",
        "agenthub-doctor-readiness",
        "agenthub-contract-readiness",
        "terminal-failure-result"
      ])
    );
    expect(new Set(AGENTHUB_FEATURE_FLAGS).size).toBe(AGENTHUB_FEATURE_FLAGS.length);
    expect(supportsAgentHubFeature("agenthub-event-envelope-schema")).toBe(true);
    expect(supportsAgentHubFeature("missing-feature")).toBe(false);
  });

  it("keeps SDK facade contract types importable from the public barrel", async () => {
    const sdkIndex = await readText("packages/sdk/src/index.ts");
    const publicTypes = [
      "AgentRunRecord",
      "TaskRecord",
      "TodoRecord",
      "ToolMetadata",
      "ToolResult",
      "WorktreeRecord"
    ];

    for (const typeName of publicTypes) {
      expect(sdkIndex).toContain(typeName);
      expect(sdkIndex).toMatch(new RegExp(`export type[\\s\\S]*\\b${typeName}\\b`));
    }
  });

  it("documents the next prerelease and tarball install gates", async () => {
    const readme = await readText("README.md");
    const releaseReadiness = await readText("docs/release-readiness.md");
    const roadmap = await readText("docs/TS重构路线图.md");
    const acceptance = await readText("docs/端到端验收清单.md");
    const packageReadmes = await Promise.all([
      readText("packages/core/README.md"),
      readText("packages/sdk/README.md"),
      readText("packages/cli/README.md")
    ]);

    for (const text of [readme, releaseReadiness, roadmap, acceptance]) {
      expect(text).toContain("pnpm contract:check");
      expect(text).toContain("pnpm release:next:check");
      expect(text).toContain("pnpm pack:smoke");
    }

    for (const text of [readme, roadmap, acceptance]) {
      expect(text).toContain("不要在检查脚本中执行 npm publish");
    }

    for (const text of [roadmap, acceptance]) {
      expect(text).toContain("Release owner 检查清单");
      expect(text).toContain("AgentHub consumption story");
      expect(text).toContain("Residual risk matrix");
      expect(text).toContain("Manual approval gate");
    }
    expect(readme).toContain("[发布准备](docs/release-readiness.md)");
    expect(readme).toContain("不要在检查脚本中执行 npm publish");
    expect(readme).toContain("AgentHub 应优先依赖 `@tokendance/code-sdk`");
    expect(readme).not.toContain("E404");
    expect(releaseReadiness).toContain("Publish Boundary");
    expect(releaseReadiness).toContain("Post-Publish Smoke");
    expect(releaseReadiness).toContain("pnpm registry:next:check");
    expect(releaseReadiness).toContain("npm publish \"<tarballPath>\" --access public --tag next");
    expect(releaseReadiness).toContain("Do not run `npm publish` from package source directories");
    expect(releaseReadiness).not.toContain("Run it from each package directory");

    for (const text of packageReadmes) {
      expect(text).toContain("pnpm contract:check");
      expect(text).toContain("Manual approval gate");
      expect(text).toContain("package-local README");
      expect(text).toContain("npm publish --tag next");
      expect(text).toContain("The `next` tag may not be public while release review is in progress");
    }
    expect(packageReadmes.join("\n")).not.toContain("It is published");
    expect(packageReadmes.join("\n")).not.toContain("https://api.vectorcontrol.tech/v1");
  });

  it("keeps TS branch docs aligned with Node packaging and global provider env boundaries", async () => {
    const readme = await readText("README.md");
    const englishReadme = await readText("README.en.md");
    const agents = await readText("AGENTS.md");

    expect(agents).toContain("Runtime: Node.js 20.18+");
    expect(agents).toContain("Package manager: pnpm");
    expect(agents).toContain("pnpm release:next:check");
    expect(agents).not.toContain("Runtime: Python");
    expect(agents).not.toContain("python -m pip");

    expect(readme).toContain("OpenAI Responses API、OpenAI Chat Completions API 与 Anthropic-compatible Messages API");
    expect(readme).toContain("TokenDanceCode 默认不读取项目根目录 `.env`");
    expect(readme).toContain("[English](README.en.md)");
    expect(readme).toContain("![Screenshot: TokenDanceCode CLI terminal session](docs/images/image-01.png)");
    expect(readme).toContain("截图展示了 `tokendance` 在 PowerShell 中启动后的本地 CLI 体验。");
    expect(readme).toContain("当前代码库已经重构为 TypeScript monorepo");
    expect(readme).not.toContain("`codex/ts-refactor` 分支");
    expect(englishReadme).toContain("[中文](README.md)");
    expect(englishReadme).toContain("![Screenshot: TokenDanceCode CLI terminal session](docs/images/image-01.png)");
    expect(englishReadme).toContain("The screenshot shows `tokendance` running as a local CLI inside PowerShell.");
    expect(englishReadme).toContain("The current codebase is a TypeScript monorepo");
    expect(englishReadme).toContain("TokenDance Gateway");
    expect(englishReadme).toContain("Subagent / worktree");
    expect(englishReadme).not.toContain("The `codex/ts-refactor` branch");
    expect(readme).not.toContain("当前实现会在启动时读取当前项目根目录的 `.env`");
    expect(readme).not.toContain("正式发布到 PyPI");
    expect(readme).not.toContain("pipx install");
  });

  it("documents Wave 5 reference architecture decisions and removes stale provider defaults", async () => {
    const readme = await readText("README.md");
    const englishReadme = await readText("README.en.md");
    const architectureBenchmark = await readText("docs/架构对标评估.md");
    const roadmap = await readText("docs/TS重构路线图.md");
    const parallelPlan = await readText("docs/并行推进计划.md");
    const acceptance = await readText("docs/端到端验收清单.md");

    for (const text of [architectureBenchmark, roadmap, parallelPlan]) {
      expect(text).toContain("CLI main.ts 过大风险");
      expect(text).toContain("command registry lane");
      expect(text).toContain("Codex contract/schema drift gate");
      expect(text).toContain("OpenCode command metadata registry");
      expect(text).toContain("拒绝 app-server daemon");
      expect(text).toContain("拒绝 OpenTUI");
      expect(text).toContain("拒绝 plugin marketplace");
      expect(text).toContain("拒绝 native installer");
    }

    expect(readme).toContain("TokenDanceCode 聚焦本地 coding-agent runtime");
    expect(readme).toContain("团队协作、多 Agent 编排和产品侧工作流由 AgentHub 承担");
    expect(englishReadme).toContain("TokenDanceCode focuses on the local coding-agent runtime");
    expect(englishReadme).toContain("AgentHub owns team workflows");
    expect(englishReadme).toContain("Common Commands");
    expect(englishReadme).toContain("Packages");
    expect(acceptance).toContain("未配置时默认是 `mock` provider、`mock` model 和 `default` permission mode");
    expect(acceptance).not.toContain("当前默认值应为 `openai`、`gpt-5.4`、`default`、`local`、`local`");
  });

  it("keeps active acceptance docs aligned with TS release and AgentHub v2 contracts", async () => {
    const acceptance = await readText("docs/端到端验收清单.md");
    const activeAcceptance = acceptance.split("## 历史附录")[0] ?? acceptance;

    expect(activeAcceptance).toContain("agentStreamSchemaVersion === 2");
    expect(activeAcceptance).toContain("source_event_type");
    expect(activeAcceptance).toContain("schema_version");
    expect(activeAcceptance).not.toContain("python -m unittest");
    expect(activeAcceptance).not.toContain("pipx");
    expect(activeAcceptance).not.toContain("tokendance 0.1.0");
  });
});

async function readJson(path: string): Promise<Record<string, any>> {
  return JSON.parse(await readText(path)) as Record<string, any>;
}

async function readText(path: string): Promise<string> {
  return readFile(new URL(path, workspaceRoot), "utf8");
}
