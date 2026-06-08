import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ModelProvider, ModelTurnRequest, ModelTurnResponse } from "@tokendance/code-core";
import { TokenDanceCode, createAgentHubApprovalBridge } from "../src/index.js";

class WriteFileProvider implements ModelProvider {
  async createTurn(request: ModelTurnRequest): Promise<ModelTurnResponse> {
    if (request.toolResults.length > 0) {
      const result = request.toolResults.at(-1);
      return {
        assistantMessage: `write ${result?.ok ? "ok" : "failed"}`,
        toolCalls: []
      };
    }

    return {
      toolCalls: [
        {
          id: "write-remote",
          name: "write_file",
          input: { path: "remote-approved.txt", content: "approved remotely" }
        }
      ]
    };
  }
}

describe("AgentHub approval bridge", () => {
  it("waits for an external AgentHub allow decision before executing a tool", async () => {
    const root = await mkdtemp(join(tmpdir(), "tdcode-approval-"));
    let releaseRequest!: () => void;
    const requestSeen = new Promise<void>((resolve) => {
      releaseRequest = resolve;
    });
    const requests: unknown[] = [];
    const bridge = createAgentHubApprovalBridge({
      clock: () => "2026-06-09T00:00:00.000Z",
      onRequest(request) {
        requests.push(request);
        releaseRequest();
      }
    });
    const client = new TokenDanceCode({
      storageRoot: root,
      provider: new WriteFileProvider(),
      approvalCallback: bridge.approvalCallback
    });
    const thread = client.startThread({ workingDirectory: root, permissionMode: "default" });

    const turnPromise = thread.run("write file after remote approval");
    await requestSeen;

    expect(requests).toEqual([
      expect.objectContaining({
        requestId: "write-remote",
        sessionId: thread.id,
        toolName: "write_file",
        status: "requires_approval",
        createdAt: "2026-06-09T00:00:00.000Z"
      })
    ]);
    expect(bridge.pending()).toEqual([
      expect.objectContaining({ requestId: "write-remote", toolName: "write_file" })
    ]);
    await expect(readFile(join(root, "remote-approved.txt"), "utf8")).rejects.toThrow();

    expect(bridge.decide("write-remote", "allow", "approved in AgentHub")).toBe(true);
    const turn = await turnPromise;

    expect(turn.finalResponse).toBe("write ok");
    await expect(readFile(join(root, "remote-approved.txt"), "utf8")).resolves.toBe("approved remotely");
    expect(turn.events).toContainEqual(
      expect.objectContaining({
        type: "tool.permission",
        decision: expect.objectContaining({ status: "allowed", reason: "approved in AgentHub" })
      })
    );
  });

  it("resolves a pending approval as denied", async () => {
    const root = await mkdtemp(join(tmpdir(), "tdcode-approval-"));
    let releaseRequest!: () => void;
    const requestSeen = new Promise<void>((resolve) => {
      releaseRequest = resolve;
    });
    const bridge = createAgentHubApprovalBridge({
      onRequest() {
        releaseRequest();
      }
    });
    const client = new TokenDanceCode({
      storageRoot: root,
      provider: new WriteFileProvider(),
      approvalCallback: bridge.approvalCallback
    });
    const thread = client.startThread({ workingDirectory: root, permissionMode: "default" });

    const turnPromise = thread.run("write file after remote denial");
    await requestSeen;
    expect(bridge.decide("write-remote", "deny", "rejected in AgentHub")).toBe(true);
    const turn = await turnPromise;

    expect(turn.finalResponse).toBe("write failed");
    await expect(readFile(join(root, "remote-approved.txt"), "utf8")).rejects.toThrow();
    expect(bridge.decide("write-remote", "allow")).toBe(false);
  });
});
