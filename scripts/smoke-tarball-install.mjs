import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packages = [
  { name: "@tokendance/code-core", prefix: "tokendance-code-core-" },
  { name: "@tokendance/code-sdk", prefix: "tokendance-code-sdk-" },
  { name: "@tokendance/code-cli", prefix: "tokendance-code-cli-" }
];

const tempRoot = await mkdtemp(join(tmpdir(), "tokendance-code-pack-smoke-"));
const tarballDir = join(tempRoot, "tarballs");

try {
  await mkdir(tarballDir, { recursive: true });

  for (const pkg of packages) {
    run("pnpm", ["--filter", pkg.name, "pack", "--pack-destination", tarballDir], workspaceRoot);
  }

  const tarballs = await readdir(tarballDir);
  const dependencies = Object.fromEntries(
    packages.map((pkg) => {
      const file = tarballs.find((entry) => entry.startsWith(pkg.prefix) && entry.endsWith(".tgz"));
      if (!file) {
        throw new Error(`Missing packed tarball for ${pkg.name}`);
      }
      return [pkg.name, `file:${join(tarballDir, file).replaceAll("\\", "/")}`];
    })
  );

  await writeFile(
    join(tempRoot, "package.json"),
    JSON.stringify({
      private: true,
      type: "module",
      dependencies,
      pnpm: {
        overrides: dependencies
      }
    }, null, 2),
    "utf8"
  );

  await writeFile(
    join(tempRoot, "smoke.mjs"),
    [
      "import { TOKEN_DANCE_CODE_PACKAGE, TokenDanceCode } from '@tokendance/code-sdk';",
      "if (TOKEN_DANCE_CODE_PACKAGE.verification.tarballSmoke !== 'pnpm pack:smoke') throw new Error('missing tarball smoke metadata');",
      "const client = new TokenDanceCode();",
      "const thread = client.startThread({ workingDirectory: process.cwd() });",
      "const turn = await thread.run('tarball smoke');",
      "if (!turn.finalResponse.includes('Mock response: tarball smoke')) throw new Error('SDK mock turn failed');"
    ].join("\n"),
    "utf8"
  );

  run("pnpm", ["install", "--ignore-scripts", "--frozen-lockfile=false"], tempRoot);
  run("node", ["smoke.mjs"], tempRoot);
  run("pnpm", ["exec", "tokendance", "--version"], tempRoot);

  console.log(`Tarball install smoke passed in ${tempRoot}`);
} finally {
  if (process.env.TOKENDANCE_KEEP_PACK_SMOKE !== "1") {
    await rm(tempRoot, { recursive: true, force: true });
  }
}

function run(command, args, cwd) {
  const result = process.platform === "win32" && command === "pnpm"
    ? spawnSync(process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", [command, ...args].map(quoteCmdArg).join(" ")], {
      cwd,
      stdio: "inherit"
    })
    : spawnSync(command, args, {
      cwd,
      stdio: "inherit"
    });

  if (result.status !== 0) {
    const detail = result.error ? ` (${result.error.message})` : "";
    throw new Error(`Command failed: ${command} ${args.join(" ")}${detail}`);
  }
}

function quoteCmdArg(value) {
  if (!/[\s"&|<>^]/.test(value)) {
    return value;
  }
  return `"${value.replaceAll('"', '\\"')}"`;
}
