// B26. How agent instructions read on screen. Pure and import-free, because
// the Tasks view is a client component and the hashing (which decides whether
// an instruction is pending) needs node:crypto: the server decides pending in
// lib/tasks/agent-instructions.ts and hands the result down as a boolean.

export interface AgentDisplay {
  agent_instructions?: string | null;
  agent_status?: string | null;
  agent_pending?: boolean;
}

export const NEEDS_YOU_HREF = "/tasks?agent=needs_you";

// The drawer's status, in plain words. `resultWhen` is already formatted IST,
// e.g. "29 Sept, 12:40".
export function agentStatusLine(t: AgentDisplay, resultWhen: string | null): string | null {
  const hasInstruction = !!t.agent_instructions && !!t.agent_instructions.trim();
  if (!hasInstruction && !t.agent_status) return null;
  if (hasInstruction && t.agent_pending) return "Waiting for the next sweep";
  if (t.agent_status === "needs_you") return "Needs you";
  if (t.agent_status === "done") return resultWhen ? `Done ${resultWhen}` : "Done";
  return null;
}

// The one marker on a task row: "Agent" while pending, "Needs you" when the
// agents have asked for him. Needs you wins, since it is the one he acts on.
export function agentMarker(t: AgentDisplay): "Agent" | "Needs you" | null {
  if (t.agent_status === "needs_you" && !t.agent_pending) return "Needs you";
  if (t.agent_pending) return "Agent";
  return null;
}

export function needsYouCount(rows: AgentDisplay[]): number {
  return rows.filter((t) => t.agent_status === "needs_you" && !t.agent_pending).length;
}

// Home: "2 agent results need you". Null when there are none.
export function needsYouLine(count: number): string | null {
  if (count <= 0) return null;
  return `${count} agent ${count === 1 ? "result needs" : "results need"} you`;
}
