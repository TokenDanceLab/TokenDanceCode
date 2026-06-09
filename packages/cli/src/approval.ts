/**
 * Local CLI approval callback for interactive permission prompts.
 */
import type { PermissionApprovalCallback } from "@tokendance/code-sdk";
import { write, type CliIO } from "./cli-io.js";

export function createLocalApprovalCallback(
  io: CliIO,
  lineIterator: AsyncIterator<string>
): PermissionApprovalCallback {
  const sessionAllowedTools = new Set<string>();
  return async (request) => {
    if (sessionAllowedTools.has(request.call.name)) {
      return { status: "allowed", reason: `approved for this CLI session: ${request.call.name}` };
    }

    await write(io.stdout, `Approval required: ${request.call.name} [${request.tool.risk}]\n`);
    await write(io.stdout, `Reason: ${request.decision.reason}\n`);
    await write(io.stdout, `Input: ${previewToolInput(request.call.input)}\n`);
    await write(io.stdout, `Allow ${request.call.name} [${request.tool.risk}]? (y=yes once, a=always this session, N=deny): `);

    const answer = await lineIterator.next();
    await write(io.stdout, "\n");
    const normalized = answer.done ? "" : answer.value.trim().toLowerCase();
    if (normalized === "y" || normalized === "yes") {
      return { status: "allowed", reason: "approved by local CLI prompt" };
    }
    if (normalized === "a" || normalized === "always") {
      sessionAllowedTools.add(request.call.name);
      return { status: "allowed", reason: `approved for this CLI session: ${request.call.name}` };
    }
    return { status: "denied", reason: "denied by local CLI prompt" };
  };
}

function previewToolInput(input: unknown): string {
  try {
    const json = JSON.stringify(input);
    return previewText(json ?? String(input));
  } catch {
    return previewText(String(input));
  }
}

function previewText(value: string): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length <= 140 ? normalized : `${normalized.slice(0, 137)}...`;
}
