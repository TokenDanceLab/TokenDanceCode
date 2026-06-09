import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { TOKEN_DANCE_CODE_PACKAGE } from "../src/index.js";

const workspaceRoot = new URL("../../../", import.meta.url);

describe("package metadata", () => {
  it("keeps public packages ready for AgentHub consumption", async () => {
    const rootPackage = await readJson("package.json");
    const ignore = await readText(".gitignore");

    expect(rootPackage.scripts?.["pack:check"]).toBe([
      "pnpm build",
      "pnpm --filter @tokendance/code-core pack --dry-run",
      "pnpm --filter @tokendance/code-sdk pack --dry-run",
      "pnpm --filter @tokendance/code-cli pack --dry-run"
    ].join(" && "));
    expect(ignore).toContain("*.tgz");

    const corePackage = await readJson("packages/core/package.json");
    const sdkPackage = await readJson("packages/sdk/package.json");
    const cliPackage = await readJson("packages/cli/package.json");

    for (const packageJson of [corePackage, sdkPackage, cliPackage]) {
      expect(packageJson.type).toBe("module");
      expect(packageJson.main).toMatch(/^\.\/dist\/.+\.js$/);
      expect(packageJson.types).toMatch(/^\.\/dist\/.+\.d\.ts$/);
      expect(packageJson.files).toEqual(["dist"]);
    }

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
          "remote-approval"
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
        package: "pnpm pack:check"
      }
    });
  });
});

async function readJson(path: string): Promise<Record<string, any>> {
  return JSON.parse(await readText(path)) as Record<string, any>;
}

async function readText(path: string): Promise<string> {
  return readFile(new URL(path, workspaceRoot), "utf8");
}
