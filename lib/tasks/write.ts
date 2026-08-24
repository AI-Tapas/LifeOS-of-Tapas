// Task writes with an explicit identity. Extracted from the tasks server
// actions so the same logic serves three callers: the browser (cookie
// session), the in-app assistant, and the MCP connector, which has no cookie
// at all. Every function takes the Supabase client and user id to act as, and
// none of them read cookies.
//
// Status changes still flow through runStatusTransition, so completion,
// reminder cleanup and recurring spawn behave identically whoever asks.

import { syncTaskReminder, removeTaskReminder } from "@/lib/reminders/writer";
import { nextDueIso, isValidRecurringRule } from "@/lib/tasks/recurring";
import { runStatusTransition, type TransitionOutcome } from "@/lib/tasks/transitions";
import type { Database } from "@/lib/database.types";
import type { SupabaseClient } from "@supabase/supabase-js";

type Db = SupabaseClient<Database>;
type TaskStatus = Database["public"]["Enums"]["task_status"];
type TaskPriority = Database["public"]["Enums"]["task_priority"];

export interface TaskInput {
  title: string;
  notes?: string | null;
  status?: TaskStatus;
  priority?: TaskPriority;
  due_ts?: string | null;
  work_stream_id: string;
  project_id?: string | null;
  recurring_rule?: string | null;
  is_billable?: boolean;
  remind_offsets?: number[];
  source?: Database["public"]["Enums"]["task_source"];
  external_ref?: string | null;
}

export type TaskResult =
  | { ok: true; id: string; reminderNote?: string }
  | { ok: false; message: string };

function reminderNote(
  outcome: { created: boolean; reason?: string } | null
): string | undefined {
  if (outcome && !outcome.created && outcome.reason) return outcome.reason;
  return undefined;
}

export async function createTask(
  supabase: Db,
  userId: string,
  input: TaskInput
): Promise<TaskResult> {
  if (!input.title.trim()) return { ok: false, message: "A title is required." };
  if (!input.work_stream_id) {
    return { ok: false, message: "A work stream is required." };
  }
  if (!isValidRecurringRule(input.recurring_rule)) {
    return { ok: false, message: "Invalid recurring rule." };
  }
  const { data, error } = await supabase
    .from("tasks")
    .insert({
      user_id: userId,
      title: input.title.trim(),
      notes: input.notes ?? null,
      status: input.status ?? "inbox",
      priority: input.priority ?? "medium",
      due_ts: input.due_ts ?? null,
      work_stream_id: input.work_stream_id,
      project_id: input.project_id ?? null,
      recurring_rule: input.recurring_rule ?? null,
      is_billable: input.is_billable ?? false,
      remind_offsets: input.remind_offsets ?? [7, 3, 1, 0],
      source: input.source ?? "manual",
      external_ref: input.external_ref ?? null,
    })
    .select("id")
    .single();
  if (error || !data) {
    return { ok: false, message: error?.message ?? "Could not save the task." };
  }

  let note: string | undefined;
  if (input.due_ts) note = reminderNote(await syncTaskReminder(userId, data.id));
  return { ok: true, id: data.id, reminderNote: note };
}

export async function updateTask(
  supabase: Db,
  userId: string,
  id: string,
  patch: Partial<TaskInput>
): Promise<TaskResult> {
  if (patch.recurring_rule !== undefined && !isValidRecurringRule(patch.recurring_rule)) {
    return { ok: false, message: "Invalid recurring rule." };
  }
  // Fields first, WITHOUT status: status (and completed_at, reminder cleanup
  // and spawning) belongs to the shared transition helper below.
  const { error } = await supabase
    .from("tasks")
    .update({
      ...(patch.title !== undefined ? { title: patch.title.trim() } : {}),
      ...(patch.notes !== undefined ? { notes: patch.notes } : {}),
      ...(patch.priority !== undefined ? { priority: patch.priority } : {}),
      ...(patch.due_ts !== undefined ? { due_ts: patch.due_ts } : {}),
      ...(patch.work_stream_id !== undefined
        ? { work_stream_id: patch.work_stream_id }
        : {}),
      ...(patch.project_id !== undefined ? { project_id: patch.project_id } : {}),
      ...(patch.recurring_rule !== undefined
        ? { recurring_rule: patch.recurring_rule }
        : {}),
      ...(patch.is_billable !== undefined ? { is_billable: patch.is_billable } : {}),
      ...(patch.remind_offsets !== undefined
        ? { remind_offsets: patch.remind_offsets }
        : {}),
    })
    .eq("id", id);
  if (error) return { ok: false, message: error.message };

  let note: string | undefined;
  if (patch.status !== undefined) {
    const t = await setTaskStatus(supabase, userId, id, patch.status);
    if (!t.ok) return { ok: false, message: t.message ?? "Could not save the task." };
    note = t.reminderNote;
  } else {
    note = reminderNote(await syncTaskReminder(userId, id));
  }
  return { ok: true, id, reminderNote: note };
}

// The ONE status-transition path. Semantics and guards live in
// lib/tasks/transitions.ts (offline-tested); this binds the database, the
// reminder writer and the spawner to it.
export async function setTaskStatus(
  supabase: Db,
  userId: string,
  taskId: string,
  nextStatus: TaskStatus
): Promise<TransitionOutcome> {
  return runStatusTransition(
    {
      readTask: async () => {
        const { data } = await supabase
          .from("tasks")
          .select("status, due_ts, recurring_rule")
          .eq("id", taskId)
          .single();
        return data ?? null;
      },
      // Compare-and-swap on the previous status, so a doubly submitted or
      // concurrent transition claims the row exactly once.
      applyStatus: async (prev, next, completedAt) => {
        const { data, error } = await supabase
          .from("tasks")
          .update({
            status: next,
            ...(completedAt !== undefined ? { completed_at: completedAt } : {}),
          })
          .eq("id", taskId)
          .eq("status", prev)
          .select("id");
        if (error) throw new Error(error.message);
        return (data?.length ?? 0) > 0;
      },
      syncReminder: () => syncTaskReminder(userId, taskId),
      spawnNext: () => spawnNextOccurrence(supabase, userId, taskId),
      now: () => new Date(),
    },
    nextStatus
  );
}

async function spawnNextOccurrence(
  supabase: Db,
  userId: string,
  taskId: string
): Promise<string | undefined> {
  const { data: t } = await supabase
    .from("tasks")
    .select(
      "title, notes, priority, due_ts, work_stream_id, project_id, recurring_rule, is_billable, remind_offsets"
    )
    .eq("id", taskId)
    .single();
  if (!t || !t.recurring_rule || !t.due_ts) return undefined;
  const next = nextDueIso(t.recurring_rule, t.due_ts);
  if (!next) return undefined;

  const { data: created } = await supabase
    .from("tasks")
    .insert({
      user_id: userId,
      title: t.title,
      notes: t.notes,
      status: "todo",
      priority: t.priority,
      due_ts: next,
      work_stream_id: t.work_stream_id,
      project_id: t.project_id,
      recurring_rule: t.recurring_rule,
      is_billable: t.is_billable,
      remind_offsets: t.remind_offsets,
      source: "manual",
    })
    .select("id")
    .single();
  if (created) {
    await syncTaskReminder(userId, created.id);
    return "Next occurrence created.";
  }
  return undefined;
}

export async function deleteTask(
  supabase: Db,
  userId: string,
  id: string
): Promise<{ ok: boolean; message?: string }> {
  // Remove the calendar reminder first, then the task (its reminders row
  // cascades). This order guarantees no orphan event on the calendar.
  await removeTaskReminder(userId, id);
  const { error } = await supabase.from("tasks").delete().eq("id", id);
  if (error) return { ok: false, message: error.message };
  return { ok: true };
}
