// B32. Billable hours this month, against the monthly target. Pure.
//
// Hours and a target only: no rupee amount is derived from them anywhere (M6d,
// B4). Which tasks count reuses B30 effectiveBillable; nothing is copied.

import { civilKey, civilToday, civilWeekday, daysInMonth, formatMonthYear, istCivil, startOfWeek, addDays } from "../datetime.ts";
import { effectiveBillable } from "../billing/unbilled.ts";
import { formatHours } from "./parse.ts";

export const DEFAULT_TARGET = 85;
export const HOURS_HREF_MISSING = "/tasks?hours=missing";

export interface HoursTask {
  id: string;
  status: string;
  completed_at: string | null;
  hours_spent: number | null;
  billable?: boolean | null;
  recurring_rule?: string | null;
  trip_id?: string | null;
  stream_name: string;
  stream_billable: boolean;
}

export interface MonthHours {
  month: string; // YYYY-MM
  label: string; // "October 2026"
  target: number;
  total: number;
  by_stream: { stream: string; hours: number }[];
  missing_count: number;
  missing_task_ids: string[];
  expected_by_today: number; // the pace
  working_days_elapsed: number;
  working_days_total: number;
}

const r2 = (n: number) => Math.round(n * 100) / 100;

// Done, effectively billable, completed inside the IST month.
function inMonth(t: HoursTask, y: number, m: number): boolean {
  if (t.status !== "done" || !t.completed_at) return false;
  const c = istCivil(t.completed_at);
  return c.y === y && c.m === m && effectiveBillable(t, t.stream_billable);
}

// Mondays to Saturdays from the 1st up to and including `upto` (a day number).
export function workingDays(y: number, m: number, upto: number): number {
  let n = 0;
  for (let d = 1; d <= Math.min(upto, daysInMonth(y, m)); d++) {
    if (civilWeekday({ y, m, d }) !== 0) n++;
  }
  return n;
}

// month: optional YYYY-MM, default the current IST month. A past month is
// fully elapsed and a future one not begun.
export function monthHours(
  tasks: HoursTask[],
  target: number,
  nowMs: number,
  month?: string
): MonthHours {
  const today = civilToday(nowMs);
  const match = month ? /^(\d{4})-(0[1-9]|1[0-2])$/.exec(month) : null;
  const y = match ? Number(match[1]) : today.y;
  const m = match ? Number(match[2]) : today.m;
  const total_days = workingDays(y, m, 31);
  const cmp = (y - today.y) * 12 + (m - today.m);
  const elapsed = cmp < 0 ? total_days : cmp > 0 ? 0 : workingDays(y, m, today.d);

  const mine = tasks.filter((t) => inMonth(t, y, m));
  const per = new Map<string, number>();
  let total = 0;
  const missing: string[] = [];
  for (const t of mine) {
    if (t.hours_spent === null || t.hours_spent === undefined) {
      missing.push(t.id);
      continue;
    }
    total += t.hours_spent;
    per.set(t.stream_name, (per.get(t.stream_name) ?? 0) + t.hours_spent);
  }
  return {
    month: `${y}-${String(m).padStart(2, "0")}`,
    label: formatMonthYear({ y, m, d: 1 }),
    target,
    total: r2(total),
    by_stream: [...per.entries()]
      .map(([stream, h]) => ({ stream, hours: r2(h) }))
      .filter((s) => s.hours > 0)
      .sort((a, b) => b.hours - a.hours || a.stream.localeCompare(b.stream)),
    missing_count: missing.length,
    missing_task_ids: missing,
    expected_by_today: total_days ? r2((target * elapsed) / total_days) : 0,
    working_days_elapsed: elapsed,
    working_days_total: total_days,
  };
}

// Home card headline: "Billable hours, October: 32.5 of 85 (on pace 38)".
export function homeHoursLine(s: MonthHours): string {
  const monthName = s.label.split(" ")[0];
  return `Billable hours, ${monthName}: ${formatHours(s.total)} of ${s.target} (on pace ${formatHours(Math.round(s.expected_by_today))})`;
}

export function missingHoursLine(n: number): string | null {
  if (n <= 0) return null;
  return `${n} finished billable ${n === 1 ? "task has" : "tasks have"} no hours`;
}

// The id list for the filtered Tasks page (?hours=missing): current month.
export function missingHoursIds(tasks: HoursTask[], nowMs: number): Set<string> {
  return new Set(monthHours(tasks, DEFAULT_TARGET, nowMs).missing_task_ids);
}

export interface WeekHours {
  total: number;
  pace: number;
}

// Hours on billable tasks completed in the previous Monday to Sunday (IST).
// ponytail: weekly pace is the target over 52/12 weeks, rounded; not tied to
// working days because a week can straddle two months.
export function lastWeekHours(tasks: HoursTask[], target: number, nowMs: number): WeekHours {
  const thisMon = startOfWeek(civilToday(nowMs), 1);
  const from = civilKey(addDays(thisMon, -7));
  const to = civilKey(thisMon); // exclusive
  let total = 0;
  for (const t of tasks) {
    if (t.status !== "done" || !t.completed_at || !effectiveBillable(t, t.stream_billable)) continue;
    const k = civilKey(istCivil(t.completed_at));
    if (k >= from && k < to) total += t.hours_spent ?? 0;
  }
  return { total: r2(total), pace: Math.round((target * 12) / 52) };
}

// Monday's brief only; null on any other weekday.
export function hoursBriefLine(w: WeekHours | null | undefined, nowMs: number): string | null {
  if (!w || civilWeekday(civilToday(nowMs)) !== 1) return null;
  return `Billable hours last week: ${formatHours(w.total)} (target pace ${w.pace}).`;
}
