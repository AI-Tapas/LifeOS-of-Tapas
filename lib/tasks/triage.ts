// Eisenhower triage, the ordering Tapas asked for in the persona interview:
// urgent and important first, then important, then urgent. Pure so the Home
// screen, the Tasks overview and the test suite all rank the same way.
//
// Definitions, deliberately simple:
//   important - priority is high. Importance is his judgment, recorded once.
//   urgent    - overdue, or due within the next 48 hours. Urgency is the
//               clock's judgment, computed fresh every render.
// A high-priority task with NO due date is the starved category from the
// interview (HUF, insurance, health): important, never urgent, first to
// vanish. It ranks in the "important" band and is flagged needs_deadline so
// the UI can offer to manufacture one.

// Relative .ts import so node --test (type stripping, no bundler) resolves it,
// same as core.ts does with tools.ts.
import { istDayKey } from "../datetime.ts";

export interface TriageTask {
  id: string;
  title: string;
  priority: "low" | "medium" | "high";
  due_ts: string | null;
  status: string;
}

export type TriageBand = "do_first" | "important" | "urgent" | "later";

export interface Triaged<T extends TriageTask> {
  do_first: T[]; // urgent and important
  important: T[]; // important, not urgent (includes needs_deadline)
  urgent: T[]; // urgent, not important
  later: T[]; // neither
}

const URGENT_WINDOW_MS = 48 * 3600 * 1000;

export function isUrgent(t: TriageTask, nowMs: number): boolean {
  if (!t.due_ts) return false;
  return Date.parse(t.due_ts) < nowMs + URGENT_WINDOW_MS;
}

export function isImportant(t: TriageTask): boolean {
  return t.priority === "high";
}

export function needsDeadline(t: TriageTask): boolean {
  return isImportant(t) && !t.due_ts;
}

// Within a band: dated before undated, earlier dates first, then priority.
const PRIORITY_ORDER = { high: 0, medium: 1, low: 2 } as const;

function bandSort(a: TriageTask, b: TriageTask): number {
  const ad = a.due_ts ?? "9999";
  const bd = b.due_ts ?? "9999";
  if (ad !== bd) return ad < bd ? -1 : 1;
  return PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority];
}

export function triage<T extends TriageTask>(tasks: T[], nowMs: number): Triaged<T> {
  const out: Triaged<T> = { do_first: [], important: [], urgent: [], later: [] };
  for (const t of tasks) {
    const urgent = isUrgent(t, nowMs);
    const important = isImportant(t);
    if (urgent && important) out.do_first.push(t);
    else if (important) out.important.push(t);
    else if (urgent) out.urgent.push(t);
    else out.later.push(t);
  }
  out.do_first.sort(bandSort);
  out.important.sort(bandSort);
  out.urgent.sort(bandSort);
  out.later.sort(bandSort);
  return out;
}

// Weekend guard (persona, inferred-accepted item 4): from Wednesday onward,
// name the tasks due Saturday to Monday so the weekend is not silently
// sacrificed. weekday is 0=Sunday..6=Saturday (civilWeekday convention).
export function weekendGuard<T extends TriageTask>(
  tasks: T[],
  weekday: number,
  dayKeysSatToMon: [string, string, string]
): T[] {
  // Fires Wednesday (3) through Friday (5): early enough to act, quiet on the
  // weekend itself, and Monday's own list handles Monday.
  if (weekday < 3 || weekday > 5) return [];
  const keys = new Set(dayKeysSatToMon);
  return tasks.filter((t) => !!t.due_ts && keys.has(istDayKey(t.due_ts)));
}
