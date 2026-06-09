import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ModelProvider, ModelTurnRequest, ModelTurnResponse, PermissionApprovalRequest } from "@tokendance/code-core";
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

class ReadEnvProvider implements ModelProvider {
  async createTurn(request: ModelTurnRequest): Promise<ModelTurnResponse> {
    if (request.toolResults.length > 0) {
      const result = request.toolResults.at(-1);
      return {
        assistantMessage: `read ${result?.ok ? "ok" : "failed"}`,
        toolCalls: []
      };
    }

    return {
      toolCalls: [
        {
          id: "read-env-remote",
          name: "read_file",
          input: { path: ".env" }
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
        schemaVersion: 1,
        sdkContractVersion: "agenthub-sdk.v1",
        source: "tokendance-code-sdk",
        decisionChannel: "agenthub.approval.v1",
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

  it("waits for an external AgentHub allow decision before executing a subject-level approval", async () => {
    const root = await mkdtemp(join(tmpdir(), "tdcode-approval-"));
    await writeFile(join(root, ".env"), "TOKEN=secret", "utf8");
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
      provider: new ReadEnvProvider(),
      approvalCallback: bridge.approvalCallback
    });
    const thread = client.startThread({ workingDirectory: root, permissionMode: "yolo" });

    const turnPromise = thread.run("read env after remote approval");
    await requestSeen;

    expect(requests).toEqual([
      expect.objectContaining({
        requestId: "read-env-remote",
        toolName: "read_file",
        status: "requires_approval",
        reason: "mode=yolo tool=read_file risk=read action=approval_required subject=path:.env: secret-like path requires approval before access"
      })
    ]);
    expect(bridge.pending()).toEqual([
      expect.objectContaining({ requestId: "read-env-remote", toolName: "read_file" })
    ]);

    expect(bridge.decide("read-env-remote", "allow", "subject approved in AgentHub")).toBe(true);
    const turn = await turnPromise;

    expect(turn.finalResponse).toBe("read ok");
    expect(turn.events).toContainEqual(
      expect.objectContaining({
        type: "tool.permission",
        decision: expect.objectContaining({ status: "allowed", reason: "subject approved in AgentHub" })
      })
    );
  });

  it("returns a denial and clears pending approvals when publishing the request fails", async () => {
    const bridge = createAgentHubApprovalBridge({
      onRequest() {
        throw new Error("hub unavailable");
      }
    });

    await expect(bridge.approvalCallback(fakeApprovalRequest("bridge-fail"))).resolves.toEqual({
      status: "denied",
      reason: "AgentHub approval request failed: hub unavailable"
    });
    expect(bridge.pending()).toEqual([]);
  });

  it("keeps duplicate tool call IDs as separate pending approvals", async () => {
    const requests: string[] = [];
    const bridge = createAgentHubApprovalBridge({
      onRequest(request) {
        requests.push(request.requestId);
      }
    });

    const first = bridge.approvalCallback(fakeApprovalRequest("duplicate-call"));
    const second = bridge.approvalCallback(fakeApprovalRequest("duplicate-call"));

    expect(requests).toEqual(["duplicate-call", "duplicate-call#2"]);
    expect(bridge.pending().map((request) => request.requestId)).toEqual(["duplicate-call", "duplicate-call#2"]);

    expect(bridge.decide("duplicate-call", "deny", "first rejected")).toBe(true);
    expect(bridge.decide("duplicate-call#2", "allow", "second approved")).toBe(true);

    await expect(first).resolves.toEqual({ status: "denied", reason: "first rejected" });
    await expect(second).resolves.toEqual({ status: "allowed", reason: "second approved" });
    expect(bridge.pending()).toEqual([]);
  });

  it("denies and clears stale approvals after the configured timeout", async () => {
    const requests: string[] = [];
    const bridge = createAgentHubApprovalBridge({
      timeoutMs: 5,
      onRequest(request) {
        requests.push(request.requestId);
      }
    });

    const approval = bridge.approvalCallback(fakeApprovalRequest("stale-call"));
    expect(requests).toEqual(["stale-call"]);
    expect(bridge.pending().map((request) => request.requestId)).toEqual(["stale-call"]);

    await expect(approval).resolves.toEqual({
      status: "denied",
      reason: "AgentHub approval timed out after 5ms"
    });
    expect(bridge.pending()).toEqual([]);
    expect(bridge.decide("stale-call", "allow", "late approval")).toBe(false);
  });

  it("rejects duplicate decisions after the first decision settles the approval", async () => {
    const bridge = createAgentHubApprovalBridge({
      timeoutMs: 1000,
      onRequest() {}
    });

    const approval = bridge.approvalCallback(fakeApprovalRequest("single-decision"));

    expect(bridge.decide("single-decision", "allow", "first decision")).toBe(true);
    expect(bridge.decide("single-decision", "deny", "duplicate decision")).toBe(false);

    await expect(approval).resolves.toEqual({ status: "allowed", reason: "first decision" });
    expect(bridge.pending()).toEqual([]);
  });

  it("keeps an in-flight decision when request publishing fails after a decision", async () => {
    let bridge!: ReturnType<typeof createAgentHubApprovalBridge>;
    bridge = createAgentHubApprovalBridge({
      onRequest(request) {
        expect(bridge.decide(request.requestId, "allow", "approved before publish failed")).toBe(true);
        throw new Error("publish failed after decision");
      }
    });

    await expect(bridge.approvalCallback(fakeApprovalRequest("pre-decided"))).resolves.toEqual({
      status: "allowed",
      reason: "approved before publish failed"
    });
    expect(bridge.pending()).toEqual([]);
  });

  it("uses isolated approval request snapshots across onRequest and pending", async () => {
    const bridge = createAgentHubApprovalBridge({
      onRequest(request) {
        (request.input as { path: string }).path = "mutated-by-hub";
      }
    });

    const approval = bridge.approvalCallback(fakeApprovalRequest("isolated-request"));

    expect(bridge.pending()).toEqual([
      expect.objectContaining({
        requestId: "isolated-request",
        input: { path: "notes.txt", content: "hello" }
      })
    ]);

    const [snapshot] = bridge.pending();
    (snapshot!.input as { path: string }).path = "mutated-by-caller";

    expect(bridge.pending()).toEqual([
      expect.objectContaining({
        requestId: "isolated-request",
        input: { path: "notes.txt", content: "hello" }
      })
    ]);
    expect(bridge.decide("isolated-request", "allow", "snapshot boundary")).toBe(true);
    await expect(approval).resolves.toEqual({ status: "allowed", reason: "snapshot boundary" });
  });
});

function fakeApprovalRequest(callId: string): PermissionApprovalRequest {
  return {
    session: {
      id: "session-1",
      cwd: process.cwd(),
      createdAt: "2026-06-09T00:00:00.000Z",
      updatedAt: "2026-06-09T00:00:00.000Z",
      permissionMode: "default",
      messages: []
    },
    turnId: "turn-1",
    call: { id: callId, name: "write_file", input: { path: "notes.txt", content: "hello" } },
    tool: {
      name: "write_file",
      description: "Write a file",
      risk: "write",
      concurrency: "exclusive",
      parse: (input) => input,
      execute: async () => ({})
    },
    decision: {
      status: "requires_approval",
      reason: "mode=default tool=write_file risk=write action=approval_required: default mode requires approval before running write tools"
    }
  };
}
