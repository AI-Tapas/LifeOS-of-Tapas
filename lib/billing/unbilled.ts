// B30. Unbilled work: the pure rules. Which finished client work has no
// invoice against it, and the checks the connector's billing tool must pass.
//
// Life OS records STATE only. There is no amount, rate, total, invoice number
// or Zoho call anywhere in here (see "Billing" in CLAUDE.md, M6d).
//
// Pure (relative .ts imports only), so scripts/b30.test.ts loads it directly.

import { civilToday, formatDateIST, istCivil } from "../datetime.ts";

export const BILLING_STATES = ["estimate_drafted", "invoiced", "not_billable"] as const;
export type BillingState = (typeof BILLING_STATES)[number];

// What the connector may write: never invoiced.
export const AGENT_BILLING_STATES = ["estimate_drafted", "not_billable"] as const;

export const REF_MAX = 40;
export const WINDOW_DAYS = 180;
export const UNBILLED_HREF = "/unbilled";

export interface BillableFields {
  billable?: boolean | null; // tasks.billable: null follows the stream
  recurring_rule?: string | null;
  trip_id?: string | null;
}

// Recurring tasks and trip checklist steps are never billable work: trips bill
// through the month pack. Otherwise the task's own choice wins, else the
// stream's tick applies. (The older is_billable column no longer counts.)
export function effectiveBillable(t: BillableFields, streamBillable: boolean): boolean {
  if (t.recurring_rule || t.trip_id) return false;
  if (t.billable === true || t.billable === false) return t.billable;
  return streamBillable;
}

export interface UnbilledInput extends BillableFields {
  id: string;
  title: string;
  status: string;
  completed_at: string | null;
  billing_state: string | null;
  billing_ref: string | null;
  work_stream_id?: string | null;
  stream_name: string;
  stream_billable: boolean;
  project_name?: string | null;
  // Tapas's B26 instruction, handed to agents on the connector only.
  agent_instructions?: string | null;
}

export interface UnbilledRow {
  id: string;
  title: string;
  project: string | null;
  completed_at: string;
  completed: string; // "17 May 2026"
  days_since: number;
  billing_state: "estimate_drafted" | null;
  billing_ref: string | null; // the estimate ref, if one was drafted
  instructions_for_agents: string | null;
}

export interface UnbilledGroup {
  stream: string;
  rows: UnbilledRow[];
}

function daysBetween(fromIso: string, nowMs: number): number {
  const a = istCivil(fromIso);
  const b = civilToday(nowMs);
  return Math.round((Date.UTC(b.y, b.m - 1, b.d) - Date.UTC(a.y, a.m - 1, a.d)) / 86400000);
}

// Finished, effectively billable, completed within 180 days, billing state
// null or estimate_drafted. Grouped by stream; rows and groups both oldest
// completion first.
export function unbilledGroups(rows: UnbilledInput[], nowMs: number): UnbilledGroup[] {
  const cutoff = nowMs - WINDOW_DAYS * 86400000;
  const groups = new Map<string, UnbilledRow[]>();
  const list = rows
    .filter(
      (t) =>
        t.status === "done" &&
        !!t.completed_at &&
        new Date(t.completed_at).getTime() >= cutoff &&
        (t.billing_state === null || t.billing_state === undefined || t.billing_state === "estimate_drafted") &&
        effectiveBillable(t, t.stream_billable)
    )
    .sort((a, b) => (a.completed_at as string).localeCompare(b.completed_at as string));
  for (const t of list) {
    const iso = t.completed_at as string;
    const row: UnbilledRow = {
      id: t.id,
      title: t.title,
      project: t.project_name ?? null,
      completed_at: iso,
      completed: formatDateIST(iso),
      days_since: daysBetween(iso, nowMs),
      billing_state: t.billing_state === "estimate_drafted" ? "estimate_drafted" : null,
      billing_ref: t.billing_state === "estimate_drafted" ? (t.billing_ref ?? null) : null,
      instructions_for_agents: t.agent_instructions?.trim() ? t.agent_instructions : null,
    };
    const key = t.stream_name;
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }
  // Rows went in oldest first, so the Map's insertion order is already the
  // order of each group's oldest completion.
  return [...groups.entries()].map(([stream, r]) => ({ stream, rows: r }));
}

export interface UnbilledSummary {
  count: number;
  streams: string[];
  oldest: string | null; // ISO instant of the oldest completion
}

export function summarise(groups: UnbilledGroup[]): UnbilledSummary {
  const all = groups.flatMap((g) => g.rows);
  const oldest = all.map((r) => r.completed_at).sort()[0] ?? null;
  return { count: all.length, streams: groups.map((g) => g.stream), oldest };
}

// The Monday brief line, or null. Stream names only: no client detail.
export function unbilledBriefLine(s: UnbilledSummary | null | undefined): string | null {
  if (!s || s.count <= 0 || !s.oldest) return null;
  const tasks = s.count === 1 ? "1 finished task" : `${s.count} finished tasks`;
  return `Unbilled work: ${tasks} across ${s.streams.join(", ")} not invoiced, oldest from ${formatDateIST(s.oldest)}.`;
}

// ---------------------------------------------------------------------------
// The connector's billing tool.
// ---------------------------------------------------------------------------
export type BillingCheck =
  | { ok: true; state: "estimate_drafted" | "not_billable"; ref: string | undefined }
  | { ok: false; message: string };

// What an agent may do: set estimate_drafted or not_billable, with an optional
// reference. It may never set invoiced, clear a state, or move a task that
// Tapas marked invoiced. The database trigger says the same.
export function checkAgentBilling(
  input: Record<string, unknown>,
  currentState: string | null
): BillingCheck {
  const state = input.state;
  if (state === "invoiced") {
    return { ok: false, message: "Only Tapas marks work invoiced, from his own session in the app. Use estimate_drafted or not_billable." };
  }
  if (state !== "estimate_drafted" && state !== "not_billable") {
    return { ok: false, message: "state must be estimate_drafted or not_billable. A state cannot be cleared from here." };
  }
  if (currentState === "invoiced") {
    return { ok: false, message: "Tapas has marked this task invoiced. Leave it as it is." };
  }
  let ref: string | undefined;
  if (input.ref !== undefined) {
    if (typeof input.ref !== "string") return { ok: false, message: "ref must be text." };
    const r = input.ref.replace(/\s+/g, " ").trim();
    if (r.length > REF_MAX) {
      return { ok: false, message: `ref is ${r.length} characters; the limit is ${REF_MAX}.` };
    }
    ref = r;
  }
  return { ok: true, state, ref };
}

// An undo that arrives over the connector is held to the same rule: it may not
// clear a state or move a task that is marked invoiced. His own session may.
export function undoAllowedForService(currentState: string | null, prevState: string | null): string | null {
  if (currentState === "invoiced") return "Tapas has marked this task invoiced, so it cannot be undone from the connector. Undo it in the app.";
  if (prevState === null || prevState === "invoiced") {
    return "That would clear a billing state, which only Tapas can do. Undo it in the app.";
  }
  return null;
}
