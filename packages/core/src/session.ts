import { randomUUID } from "node:crypto";
import type { PermissionMode, SessionState, TDMessage } from "./types.js";

export interface CreateSessionOptions {
  cwd: string;
  id?: string;
  permissionMode?: PermissionMode;
}

export function createSession(options: CreateSessionOptions): SessionState {
  const now = new Date().toISOString();
  return {
    id: options.id ?? randomUUID(),
    cwd: options.cwd,
    createdAt: now,
    updatedAt: now,
    permissionMode: options.permissionMode ?? "default",
    messages: []
  };
}

export function appendMessage(session: SessionState, message: TDMessage): SessionState {
  return {
    ...session,
    updatedAt: new Date().toISOString(),
    messages: [...session.messages, message]
  };
}
