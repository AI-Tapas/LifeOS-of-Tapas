// B30. Reads the finished tasks the unbilled list is built from, for the
// /unbilled page (cookie client), the Monday brief and the connector (service
// client). One query, one place, so the three cannot disagree. The rules
// themselves are pure, in unbilled.ts.

import { unbilledGroups, WINDOW_DAYS, type UnbilledGroup, type UnbilledInput } from "./unbilled.ts";
import type { Database } from "../database.types.ts";
import type { SupabaseClient } from "@supabase/supabase-js";

export async function loadUnbilled(
  supabase: SupabaseClient<Database>,
  userId: string,
  nowMs: number = Date.now()
): Promise<UnbilledGroup[]> {
  const cutoff = new Date(nowMs - WINDOW_DAYS * 86400000).toISOString();
  const { data, error } = await supabase
    .from("tasks")
    .select(
      "id, title, status, completed_at, billable, is_billable, billing_state, billing_ref, recurring_rule, trip_id, agent_instructions, work_streams(name, billable), projects(name)"
    )
    .eq("user_id", userId)
    .eq("status", "done")
    .gte("completed_at", cutoff);
  if (error) throw new Error(error.message);
  const rows: UnbilledInput[] = (data ?? []).map((t) => {
    const stream = t.work_streams as { name: string; billable: boolean } | null;
    return {
      id: t.id,
      title: t.title,
      status: t.status,
      completed_at: t.completed_at,
      billable: t.billable,
      is_billable: t.is_billable,
      billing_state: t.billing_state,
      billing_ref: t.billing_ref,
      recurring_rule: t.recurring_rule,
      trip_id: t.trip_id,
      stream_name: stream?.name ?? "No stream",
      stream_billable: stream?.billable === true,
      project_name: (t.projects as { name: string } | null)?.name ?? null,
      agent_instructions: t.agent_instructions,
    };
  });
  return unbilledGroups(rows, nowMs);
}
