#!/usr/bin/env node
import { TokenDanceCode } from "@tokendance/code-sdk";

const version = "0.2.0-ts.0";

async function main(argv: string[]): Promise<void> {
  const [command, ...rest] = argv;

  if (!command || command === "--help" || command === "-h") {
    printHelp();
    return;
  }

  if (command === "--version" || command === "-v") {
    console.log(version);
    return;
  }

  if (command === "doctor") {
    console.log(`TokenDanceCode ${version}`);
    console.log(`Node ${process.version}`);
    console.log(`cwd ${process.cwd()}`);
    console.log(`platform ${process.platform}`);
    return;
  }

  if (command === "run") {
    const prompt = rest.join(" ").trim();
    if (!prompt) {
      throw new Error("tokendance run requires a prompt");
    }
    const client = new TokenDanceCode();
    const thread = client.startThread({ workingDirectory: process.cwd() });
    const turn = await thread.run(prompt);
    console.log(turn.finalResponse);
    return;
  }

  throw new Error(`Unknown command: ${command}`);
}

function printHelp(): void {
  console.log(`TokenDanceCode ${version}

Usage:
  tokendance --version
  tokendance doctor
  tokendance run <prompt>
`);
}

main(process.argv.slice(2)).catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exitCode = 1;
});
