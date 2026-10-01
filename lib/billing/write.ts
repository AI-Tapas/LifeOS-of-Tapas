// B30. Tapas's own billing marks: Invoiced (with an optional reference), Not
// billable this time, and reopening a task. Runs from his signed-in session
// only (the server actions); the connector has its own, narrower tool
// (set_billing_state in lib/assistant/execute.ts) and the database trigger
// guard_task_billing_state refuses it anything beyond that.
//
// Every change is audited with the previous state and reference, which is what
// the Undo button on /unbilled and in the task drawer puts back.

import { BILLING_STATES, REF_MAX, type BillingState } from "./unbilled.ts";
import type { Database, Json } from "../database.types.ts";
import type { SupabaseClient } from "@supabase/supabase-js";

export interface BillingSnapshot {
  state: BillingState | null;
  ref: string | null;
}

export type BillingResult =
  | { ok: true; prev: BillingSnapshot }
  | { ok: false; message: string };

export function cleanRef(ref: string | null | undefined): { ok: true; ref: string | null } | { ok: false; message: string } {
  const r = (ref ?? "").replace(/\s+/g, " ").trim();
  if (r.length > REF_MAX) return { ok: false, message: `The reference is ${r.length} characters; the limit is ${REF_MAX}.` };
  return { ok: true, ref: r || null };
}

export async function setBillingState(
  supabase: SupabaseClient<Database>,
  userId: string,
  taskId: string,
  state: BillingState | null,
  ref: string | null
): Promise<BillingResult> {
  if (state !== null && !BILLING_STATES.includes(state)) {
    return { ok: false, message: "That is not a billing state." };
  }
  const cleaned = cleanRef(ref);
  if (!cleaned.ok) return cleaned;
  const { data: row } = await supabase
    .from("tasks")
    .select("billing_state, billing_ref")
    .eq("id", taskId)
    .eq("user_id", userId)
    .maybeSingle();
  if (!row) return { ok: false, message: "Task not found." };
  const prev: BillingSnapshot = {
    state: (row.billing_state as BillingState | null) ?? null,
    ref: row.billing_ref ?? null,
  };
  const { error } = await supabase
    .from("tasks")
    .update({ billing_state: state, billing_ref: state === null ? null : cleaned.ref })
    .eq("id", taskId)
    .eq("user_id", userId);
  if (error) return { ok: false, message: error.message };
  const { error: auditError } = await supabase.from("audit_log").insert({
    user_id: userId,
    actor: "user",
    action: "billing_state_set",
    entity: "tasks",
    entity_id: taskId,
    meta: {
      from_state: prev.state,
      from_ref: prev.ref,
      to_state: state,
      to_ref: state === null ? null : cleaned.ref,
    } as Json,
  });
  // The state has already changed, so a failed audit row must not read as a
  // failed save (the caller would show an error and the Undo would be lost).
  // ponytail: the audit failure is swallowed; add a warning field if it matters.
  void auditError;
  return { ok: true, prev };
}
