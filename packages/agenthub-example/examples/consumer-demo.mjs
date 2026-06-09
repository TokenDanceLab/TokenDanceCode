#!/usr/bin/env node
/**
 * Minimal AgentHub consumer example.
 *
 * Demonstrates how to consume @tokendance/code-sdk from an external AgentHub
 * server or integration. This file is NOT published to npm; it lives in the
 * private @tokendance/code-agenthub-example package for local development.
 *
 * Usage:
 *   node examples/consumer-demo.mjs
 *
 * The demo uses the mock provider by default. Set env vars to use a real one:
 *   TOKENDANCE_PROVIDER=openai-chat-completions
 *   TOKENDANCE_MODEL=deepseek-v4-pro
 *   TOKENDANCE_GATEWAY_API_KEY=sk-xxx
 *   TOKENDANCE_GATEWAY_BASE_URL=https://api.vectorcontrol.tech/v1
 */

import {
  createAgentHubTokenDanceRunner,
  createAgentHubTokenDanceConsumerFixture,
  type AgentHubTokenDanceRunOptions,
  type AgentHubTokenDanceConsumerFixture
} from "@tokendance/code-sdk";

// --- Event collection (in production, wire to your event bus) ---

const agentStreamEvents: unknown[] = [];
const approvalRequests: unknown[] = [];

function emitAgentStream(payload: unknown): Promise<void> {
  agentStreamEvents.push(payload);
  // In production: forward to your AgentHub Hub Server
  // await hubClient.postAgentStream(payload);
  return Promise.resolve();
}

function onApprovalRequest(request: unknown): Promise<void> {
  approvalRequests.push(request);
  // In production: create an approval record in your Hub
  // await hubClient.createApproval(request);
  console.log("[approval-request]", JSON.stringify(request, null, 2));
  return Promise.resolve();
}

// --- Runner setup ---

const runner = createAgentHubTokenDanceRunner({
  storageRoot: ".tokendance-code",
  emitAgentStream,
  onApprovalRequest
});

// --- Demo run ---

async function main(): Promise<void> {
  const runOptions: AgentHubTokenDanceRunOptions = {
    prompt: "Hello! List 3 interesting facts about TypeScript.",
    workingDirectory: process.cwd(),
    taskId: "demo-task-001",
    edgeRunId: "demo-edge-run-001",
    sessionId: "demo-session-001",
    agentInstanceId: "demo-agent-001"
  };

  console.log("=== AgentHub Consumer Demo ===");
  console.log(`Provider: ${process.env.TOKENDANCE_PROVIDER ?? "mock"}`);
  console.log(`Prompt: ${runOptions.prompt}`);
  console.log(`Session: ${runOptions.sessionId}`);
  console.log("");

  try {
    const result = await runner.run(runOptions);
    console.log("=== Run Result ===");
    console.log(`Success: ${result.success}`);
    console.log(`Thread ID: ${result.threadId}`);
    console.log(`Session ID: ${result.sessionId}`);
    if (result.finalResponse) {
      console.log(`Response: ${result.finalResponse.slice(0, 200)}${result.finalResponse.length > 200 ? "..." : ""}`);
    }
    if (result.error) {
      console.log(`Error: ${result.error.message}`);
    }
  } catch (error) {
    console.error("Run failed:", error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }

  console.log("");
  console.log(`Agent stream events: ${agentStreamEvents.length}`);
  console.log(`Approval requests: ${approvalRequests.length}`);
}

// --- Fixture demo (alternative approach) ---

async function fixtureDemo(): Promise<void> {
  console.log("\n=== AgentHub Consumer Fixture Demo ===\n");

  const fixture = createAgentHubTokenDanceConsumerFixture({
    storageRoot: ".tokendance-code-fixture",
    defaultRun: {
      workingDirectory: process.cwd(),
      taskId: "fixture-task-001",
      edgeRunId: "fixture-edge-001",
      sessionId: "fixture-session-001",
      agentInstanceId: "fixture-agent-001"
    },
    defaultLogin: {
      clientId: "agenthub-local-demo",
      redirectUri: "http://127.0.0.1:48731/callback",
      deviceType: "desktop"
    }
  });

  // Startup checks (doctor + package info)
  const startup = await fixture.startup({ workingDirectory: process.cwd() });
  console.log(`SDK contract version: ${startup.packageInfo.agentHub.sdkContractVersion}`);
  console.log(`Doctor ready: ${startup.doctor.agentHub.ready}`);
  if (startup.doctor.agentHub.warningChecks.length > 0) {
    console.log(`Warnings: ${startup.doctor.agentHub.warningChecks.join(", ")}`);
  }

  // TokenDanceID login URL (no token exchange in this demo)
  const login = fixture.login({ state: "demo-state-001" });
  console.log(`\nLogin URL (first 80 chars): ${login.authorizationUrl.slice(0, 80)}...`);

  // Run a prompt through the fixture
  await fixture.run({ prompt: "What is 2+2? Reply with just the number." });

  console.log(`\nEmitted events: ${fixture.events().length}`);
  console.log(`Approvals: ${fixture.approvals().length}`);

  if (fixture.events().length > 0) {
    const types = fixture.events().map((e) => e.event_type);
    console.log(`Event types: ${[...new Set(types)].join(", ")}`);
  }
}

// Run both demos
main()
  .then(() => fixtureDemo())
  .catch((error) => {
    console.error("Demo failed:", error);
    process.exitCode = 1;
  });
