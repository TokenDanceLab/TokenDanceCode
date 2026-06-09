import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const workspaceRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const defaultEnvFile = ".config/tokendance/gateway-smoke.env";
const defaultModels = ["deepseek-v4-pro", "glm-5.1", "gpt-5.5"];

await main();

async function main() {
  const loadedEnv = await loadSmokeEnv();
  const env = {
    ...process.env,
    ...loadedEnv,
    TOKENDANCE_PROVIDER: "openai-chat-completions"
  };
  const secretValues = secretValuesForRedaction(env);

  assert(env.TOKENDANCE_RUN_REAL_PROVIDER_SMOKE === "1", "Set TOKENDANCE_RUN_REAL_PROVIDER_SMOKE=1 to opt in to real Gateway smoke.");
  assertPresent(env.TOKENDANCE_GATEWAY_API_KEY, "TOKENDANCE_GATEWAY_API_KEY");
  assertPresent(env.TOKENDANCE_GATEWAY_BASE_URL, "TOKENDANCE_GATEWAY_BASE_URL");

  const models = parseModels(env.TOKENDANCE_REAL_SMOKE_MODELS);
  assert(models.length > 0, "No smoke models configured.");

  await runPnpm(["--filter", "@tokendance/code-cli", "build"], { env, secretValues });

  const doctor = JSON.parse(await run(process.execPath, ["packages/cli/dist/main.js", "doctor", "--json"], { env: withModel(env, models[0]), secretValues }));
  assert(doctor.config?.provider === "openai-chat-completions", `doctor provider drifted: ${doctor.config?.provider}`);
  assert(doctor.config?.model === models[0], `doctor model drifted: ${doctor.config?.model}`);
  assert(doctor.config?.validation?.ready === true, "doctor provider readiness is not true");

  const validation = JSON.parse(await run(process.execPath, ["packages/cli/dist/main.js", "config", "validate", "--json"], { env: withModel(env, models[0]), secretValues }));
  assert(validation.validation?.ready === true, "config validate readiness is not true");
  assert(validation.validation?.credentials?.apiKey === "present", "config validate did not see Gateway API key as present");
  assert(validation.validation?.credentials?.apiKeyEnv === "TOKENDANCE_GATEWAY_API_KEY", "config validate did not use Gateway API key env");
  assert(validation.validation?.baseUrl?.baseUrlEnv === "TOKENDANCE_GATEWAY_BASE_URL", "config validate did not use Gateway base URL env");

  for (const model of models) {
    const sentinel = sentinelFor(model);
    const output = await run(
      process.execPath,
      ["packages/cli/dist/main.js", "run", `Reply with exactly ${sentinel} and no extra text.`],
      { env: withModel(env, model), secretValues }
    );
    assert(output.includes(sentinel), `model ${model} did not return sentinel ${sentinel}`);
    console.log(`Gateway smoke passed for ${model}: ${sentinel}`);
  }

  console.log(`Gateway smoke completed for ${models.length} model(s).`);
}

async function loadSmokeEnv() {
  const envFile = process.env.TOKENDANCE_REAL_SMOKE_ENV_FILE ?? defaultEnvFile;
  if (!existsSync(resolve(workspaceRoot, envFile))) {
    return {};
  }
  const text = await readFile(resolve(workspaceRoot, envFile), "utf8");
  const env = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }
    const index = line.indexOf("=");
    if (index <= 0) {
      continue;
    }
    const key = line.slice(0, index).trim();
    const value = line.slice(index + 1).trim();
    env[key] = unquote(value);
  }
  return env;
}

function withModel(env, model) {
  return {
    ...env,
    TOKENDANCE_MODEL: model,
    TOKENDANCE_OPENAI_CHAT_TEST_MODEL: model
  };
}

function parseModels(value) {
  return (value?.trim() ? value.split(",") : defaultModels).map((model) => model.trim()).filter(Boolean);
}

function sentinelFor(model) {
  const label = model.toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  return `TOKENDANCE_${label}_SMOKE_OK`;
}

function secretValuesForRedaction(env) {
  return [
    env.TOKENDANCE_GATEWAY_API_KEY,
    env.TOKENDANCE_GATEWAY_BASE_URL,
    env.OPENAI_API_KEY,
    env.ANTHROPIC_API_KEY
  ].filter((value) => typeof value === "string" && value.length >= 8);
}

function redact(text, secretValues) {
  let output = text;
  for (const value of secretValues) {
    output = output.split(value).join("<redacted>");
  }
  return output;
}

function run(command, args, options) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, {
      cwd: workspaceRoot,
      env: options.env
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", rejectRun);
    child.on("close", (code) => {
      const redactedStdout = redact(stdout, options.secretValues);
      const redactedStderr = redact(stderr, options.secretValues);
      if (code !== 0) {
        rejectRun(new Error(`${command} ${args.join(" ")} failed with ${code}\n${redactedStdout}\n${redactedStderr}`.trim()));
        return;
      }
      resolveRun(redactedStdout);
    });
  });
}

function runPnpm(args, options) {
  if (process.platform !== "win32") {
    return run("pnpm", args, options);
  }
  const comspec = process.env.ComSpec ?? "C:\\Windows\\System32\\cmd.exe";
  return run(comspec, ["/d", "/s", "/c", "pnpm", ...args], options);
}

function assertPresent(value, name) {
  assert(typeof value === "string" && value.trim().length > 0, `${name} is required for real Gateway smoke.`);
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function unquote(value) {
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  return value;
}
