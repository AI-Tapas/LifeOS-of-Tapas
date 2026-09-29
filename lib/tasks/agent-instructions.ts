// B26. Instructions for agents on a task: the pure rules.
//
// Tapas writes an instruction in the app; the daytime agent sweeps read it
// through the connector and report a result. Only his own signed-in session
// may write the instruction: the database refuses everyone else (migration
// 20260929000100, trigger guard_task_agent_instructions). Nothing here writes.
//
// "Pending" is DERIVED, never stored: a non-blank instruction on a task that
// is not done or dropped, whose hash differs from agent_done_hash. The server
// always computes the hash; agents only echo it back.
//
// Pure (relative .ts imports only), so scripts/b26.test.ts loads it directly.

import { hashPayload } from "../assistant/core.ts";
import { RESULT_MAX } from "./agent-limits.ts";

export { INSTRUCTION_MAX, RESULT_MAX } from "./agent-limits.ts";
export const AGENT_STATUSES = ["done", "needs_you"] as const;
export type AgentStatus = (typeof AGENT_STATUSES)[number];

// The columns no tool, no parameter and no copy path may ever carry.
export const INSTRUCTION_COLUMNS = ["agent_instructions", "agent_instructions_at"] as const;

export interface AgentFields {
  status?: string;
  agent_instructions?: string | null;
  agent_done_hash?: string | null;
  agent_status?: string | null;
}

// Blank (empty or whitespace only) is the same as no instruction.
export function isBlank(text: string | null | undefined): boolean {
  return !text || !text.trim();
}

// sha256 of the exact stored text.
export function instructionHash(text: string): string {
  return hashPayload(text);
}

export function isPendingInstruction(t: AgentFields): boolean {
  if (isBlank(t.agent_instructions)) return false;
  if (t.status === "done" || t.status === "dropped") return false;
  return instructionHash(t.agent_instructions as string) !== (t.agent_done_hash ?? null);
}

// Oldest instruction first, at most `limit`.
export function pendingOldestFirst<T extends AgentFields & { agent_instructions_at?: string | null }>(
  rows: T[],
  limit = 10
): T[] {
  return rows
    .filter(isPendingInstruction)
    .sort((a, b) => (a.agent_instructions_at ?? "").localeCompare(b.agent_instructions_at ?? ""))
    .slice(0, limit);
}

export type ReportCheck =
  | { ok: true; status: AgentStatus; result: string }
  | { ok: false; message: string };

// The arguments of report_agent_result, before any row is read.
export function checkReportArgs(input: Record<string, unknown>): ReportCheck {
  const status = input.status;
  if (status !== "done" && status !== "needs_you") {
    return { ok: false, message: "status must be done or needs_you." };
  }
  const result = typeof input.result === "string" ? input.result.trim() : "";
  if (!result) return { ok: false, message: "result is required: say what was done, or what you need from Tapas." };
  if (result.length > RESULT_MAX) {
    return { ok: false, message: `result is ${result.length} characters; the limit is ${RESULT_MAX}. Shorten it.` };
  }
  return { ok: true, status, result };
}
