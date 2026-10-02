// B32. Reads what the hours summaries are built from, for Home, the Tasks
// filter, the Monday brief and the connector, so they cannot disagree. The
// rules are pure, in month.ts. Hours and a target only: no amount.

import { monthHours, lastWeekHours, DEFAULT_TARGET, type HoursTask, type MonthHours, type WeekHours } from "./month.ts";
import type { Database } from "../database.types.ts";
import type { SupabaseClient } from "@supabase/supabase-js";

type Db = SupabaseClient<Database>;

export async function loadTarget(supabase: Db, userId: string): Promise<number> {
  const { data } = await supabase
    .from("assistant_settings")
    .select("monthly_hours_target")
    .eq("user_id", userId)
    .maybeSingle();
  return data?.monthly_hours_target ?? DEFAULT_TARGET;
}

// Done tasks completed since `sinceIso`, shaped for the pure functions.
export async function loadHoursTasks(
  supabase: Db,
  userId: string,
  sinceIso: string,
  untilIso?: string
): Promise<HoursTask[]> {
  let q = supabase
    .from("tasks")
    .select("id, status, completed_at, hours_spent, billable, recurring_rule, trip_id, work_streams(name, billable)")
    .eq("user_id", userId)
    .eq("status", "done")
    .gte("completed_at", sinceIso);
  if (untilIso) q = q.lte("completed_at", untilIso);
  const { data, error } = await q;
  if (error) throw new Error(error.message);
  return (data ?? []).map((t) => {
    const s = t.work_streams as { name: string; billable: boolean } | null;
    return {
      id: t.id,
      status: t.status,
      completed_at: t.completed_at,
      hours_spent: t.hours_spent === null ? null : Number(t.hours_spent),
      billable: t.billable,
      recurring_rule: t.recurring_rule,
      trip_id: t.trip_id,
      stream_name: s?.name ?? "No stream",
      stream_billable: s?.billable === true,
    };
  });
}

// A month plus a day of slack either side covers any IST boundary.
function sinceFor(nowMs: number, month?: string): string {
  const m = month && /^(\d{4})-(\d{2})$/.test(month) ? month : null;
  const start = m ? Date.UTC(Number(m.slice(0, 4)), Number(m.slice(5)) - 1, 1) - 2 * 86400000 : nowMs - 40 * 86400000;
  return new Date(Math.min(start, nowMs - 9 * 86400000)).toISOString();
}

// A named month ends two days after its last day (IST slack); the current
// month needs no cap.
function untilFor(month?: string): string | undefined {
  const m = month && /^(\d{4})-(\d{2})$/.exec(month);
  return m ? new Date(Date.UTC(Number(m[1]), Number(m[2]), 3)).toISOString() : undefined;
}

export async function loadMonthHours(supabase: Db, userId: string, nowMs: number = Date.now(), month?: string): Promise<MonthHours> {
  const [tasks, target] = await Promise.all([
    loadHoursTasks(supabase, userId, sinceFor(nowMs, month), untilFor(month)),
    loadTarget(supabase, userId),
  ]);
  return monthHours(tasks, target, nowMs, month);
}

export async function loadLastWeekHours(supabase: Db, userId: string, nowMs: number = Date.now()): Promise<WeekHours> {
  const [tasks, target] = await Promise.all([
    loadHoursTasks(supabase, userId, sinceFor(nowMs)),
    loadTarget(supabase, userId),
  ]);
  return lastWeekHours(tasks, target, nowMs);
}
