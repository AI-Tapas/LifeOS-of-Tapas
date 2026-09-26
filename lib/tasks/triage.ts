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
//
// B19, a start date. not_before is the IST date before which a task cannot
// sensibly start (the October invoice, in September). Until that day the task
// is WAITING: it sits in no band, it is never urgent whatever its due date,
// and every surface counts it instead of listing it. Decided here, once, so
// Home, the Tasks overview, the brief and the trip rollup cannot disagree.

// Relative .ts import so node --test (type stripping, no bundler) resolves it,
// same as core.ts does with tools.ts.
import { istDayKey } from "../datetime.ts";

export interface TriageTask {
  id: string;
  title: string;
  priority: "low" | "medium" | "high";
  due_ts: string | null;
  status: string;
  // IST date (YYYY-MM-DD) before which the task cannot start. Optional so
  // rows loaded without the column (and the older fixtures) read as
  // "available now", which is what every task was before B19.
  not_before?: string | null;
}

export type TriageBand = "do_first" | "important" | "urgent" | "later";

export interface Triaged<T extends TriageTask> {
  do_first: T[]; // urgent and important
  important: T[]; // important, not urgent (includes needs_deadline)
  urgent: T[]; // urgent, not important
  later: T[]; // neither
  // Not yet startable (not_before after today, IST). In no band: counted,
  // never listed, and earliest start first so the next one to arrive leads.
  waiting: T[];
}

const URGENT_WINDOW_MS = 48 * 3600 * 1000;

// Both sides are YYYY-MM-DD, so string order is date order.
export function isWaiting(t: Pick<TriageTask, "not_before">, nowMs: number): boolean {
  return !!t.not_before && t.not_before > istDayKey(new Date(nowMs));
}

export function isUrgent(t: TriageTask, nowMs: number): boolean {
  if (!t.due_ts) return false;
  // A task that cannot start yet is never urgent, whatever its due date.
  if (isWaiting(t, nowMs)) return false;
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
  const out: Triaged<T> = { do_first: [], important: [], urgent: [], later: [], waiting: [] };
  for (const t of tasks) {
    if (isWaiting(t, nowMs)) {
      out.waiting.push(t);
      continue;
    }
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
  out.waiting.sort(
    (a, b) => (a.not_before! < b.not_before! ? -1 : a.not_before! > b.not_before! ? 1 : bandSort(a, b))
  );
  return out;
}

// The one sentence every surface uses for the count, so Home, the Tasks
// overview and the brief cannot word it differently. Null when none wait.
export function waitingLine(count: number): string | null {
  if (count <= 0) return null;
  return `${count} ${count === 1 ? "task is" : "tasks are"} waiting for ${count === 1 ? "its" : "their"} start date.`;
}

// Why a start date cannot be stored, or null when it can. The format is the
// same as a due date's (YYYY-MM-DD, an IST calendar date). A start after the
// due date would hide a task until it is already overdue, which is the one
// thing this app must never do, so it is refused rather than clamped: the
// caller has mixed the two dates up, and guessing which one it meant is
// worse than saying so. The database carries the same rule as a check
// constraint (migration 20260927000100).
export function startDateProblem(
  notBefore: string | null | undefined,
  dueTs: string | null | undefined
): string | null {
  if (notBefore == null) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(notBefore);
  const real =
    m &&
    new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])).toISOString().slice(0, 10) === notBefore;
  if (!real) return `not_before must be a date as YYYY-MM-DD, got "${notBefore}".`;
  if (dueTs && notBefore > istDayKey(dueTs)) {
    return `not_before (${notBefore}) is after the due date (${istDayKey(dueTs)}): a task cannot start after it is due. Move one of the two dates.`;
  }
  return null;
}

// Weekend guard (persona, inferred-accepted item 4): from Wednesday onward,
// name the tasks due Saturday to Monday so the weekend is not silently
// sacrificed. weekday is 0=Sunday..6=Saturday (civilWeekday convention).
// nowMs, when given, leaves out tasks still waiting for their start date: the
// guard's advice is "start it before Friday evening", which is wrong for work
// that cannot start yet.
export function weekendGuard<T extends TriageTask>(
  tasks: T[],
  weekday: number,
  dayKeysSatToMon: [string, string, string],
  nowMs?: number
): T[] {
  // Fires Wednesday (3) through Friday (5): early enough to act, quiet on the
  // weekend itself, and Monday's own list handles Monday.
  if (weekday < 3 || weekday > 5) return [];
  const keys = new Set(dayKeysSatToMon);
  return tasks.filter(
    (t) =>
      !!t.due_ts &&
      keys.has(istDayKey(t.due_ts)) &&
      (nowMs === undefined || !isWaiting(t, nowMs))
  );
}
