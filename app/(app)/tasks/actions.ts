"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { syncTaskReminder, removeTaskReminder } from "@/lib/reminders/writer";
import { nextDueIso, isValidRecurringRule } from "@/lib/tasks/recurring";
import type { Database } from "@/lib/database.types";

type TaskStatus = Database["public"]["Enums"]["task_status"];
type TaskPriority = Database["public"]["Enums"]["task_priority"];

async function requireUser() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new Error("not signed in");
  return { supabase, user };
}

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
}

export type TaskResult =
  | { ok: true; id: string; reminderNote?: string }
  | { ok: false; message: string };

function reminderNote(outcome: { created: boolean; reason?: string } | null): string | undefined {
  if (outcome && !outcome.created && outcome.reason) return outcome.reason;
  return undefined;
}

export async function createTaskAction(input: TaskInput): Promise<TaskResult> {
  const { supabase, user } = await requireUser();
  if (!input.title.trim()) return { ok: false, message: "A title is required." };
  if (!input.work_stream_id) return { ok: false, message: "A work stream is required." };
  if (!isValidRecurringRule(input.recurring_rule)) {
    return { ok: false, message: "Invalid recurring rule." };
  }
  const { data, error } = await supabase
    .from("tasks")
    .insert({
      user_id: user.id,
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
      source: "manual",
    })
    .select("id")
    .single();
  if (error || !data) return { ok: false, message: error?.message ?? "Could not save the task." };

  let note: string | undefined;
  if (input.due_ts) {
    const outcome = await syncTaskReminder(user.id, data.id);
    note = reminderNote(outcome);
  }
  revalidatePath("/tasks");
  return { ok: true, id: data.id, reminderNote: note };
}

export async function updateTaskAction(
  id: string,
  patch: Partial<TaskInput>
): Promise<TaskResult> {
  const { supabase, user } = await requireUser();
  if (patch.recurring_rule !== undefined && !isValidRecurringRule(patch.recurring_rule)) {
    return { ok: false, message: "Invalid recurring rule." };
  }
  const { error } = await supabase
    .from("tasks")
    .update({
      ...(patch.title !== undefined ? { title: patch.title.trim() } : {}),
      ...(patch.notes !== undefined ? { notes: patch.notes } : {}),
      ...(patch.status !== undefined ? { status: patch.status } : {}),
      ...(patch.priority !== undefined ? { priority: patch.priority } : {}),
      ...(patch.due_ts !== undefined ? { due_ts: patch.due_ts } : {}),
      ...(patch.work_stream_id !== undefined ? { work_stream_id: patch.work_stream_id } : {}),
      ...(patch.project_id !== undefined ? { project_id: patch.project_id } : {}),
      ...(patch.recurring_rule !== undefined ? { recurring_rule: patch.recurring_rule } : {}),
      ...(patch.is_billable !== undefined ? { is_billable: patch.is_billable } : {}),
      ...(patch.remind_offsets !== undefined ? { remind_offsets: patch.remind_offsets } : {}),
    })
    .eq("id", id);
  if (error) return { ok: false, message: error.message };

  // Any change to the due date, offsets or status re-syncs the reminder.
  const outcome = await syncTaskReminder(user.id, id);
  revalidatePath("/tasks");
  return { ok: true, id, reminderNote: reminderNote(outcome) };
}

export async function setTaskStatusAction(
  id: string,
  status: TaskStatus
): Promise<TaskResult> {
  const { supabase, user } = await requireUser();
  const completing = status === "done";
  const { error } = await supabase
    .from("tasks")
    .update({
      status,
      completed_at: completing ? new Date().toISOString() : null,
    })
    .eq("id", id);
  if (error) return { ok: false, message: error.message };

  let spawnedNote: string | undefined;
  if (status === "done" || status === "dropped") {
    // Remove this occurrence's reminder.
    await syncTaskReminder(user.id, id);
    // Completing a recurring task spawns the next occurrence.
    if (completing) spawnedNote = await spawnNextOccurrence(supabase, user.id, id);
  } else {
    await syncTaskReminder(user.id, id);
  }
  revalidatePath("/tasks");
  return { ok: true, id, reminderNote: spawnedNote };
}

async function spawnNextOccurrence(
  supabase: Awaited<ReturnType<typeof requireUser>>["supabase"],
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

export async function deleteTaskAction(id: string): Promise<{ ok: boolean; message?: string }> {
  const { supabase, user } = await requireUser();
  // Remove the Google reminder event first, then delete the task (its reminders
  // row cascades). This order guarantees no orphan event on the calendar.
  await removeTaskReminder(user.id, id);
  const { error } = await supabase.from("tasks").delete().eq("id", id);
  if (error) return { ok: false, message: error.message };
  revalidatePath("/tasks");
  return { ok: true };
}

export async function quickAddTaskAction(
  title: string,
  workStreamId: string
): Promise<TaskResult> {
  return createTaskAction({ title, work_stream_id: workStreamId, status: "inbox" });
}

// ---------------------------------------------------------------------------
// Projects
// ---------------------------------------------------------------------------
type ProjectStatus = Database["public"]["Enums"]["project_status"];

export interface ProjectInput {
  name: string;
  work_stream_id: string;
  status?: ProjectStatus;
  notes?: string | null;
}

export async function createProjectAction(
  input: ProjectInput
): Promise<{ ok: boolean; id?: string; message?: string }> {
  const { supabase, user } = await requireUser();
  if (!input.name.trim()) return { ok: false, message: "A name is required." };
  if (!input.work_stream_id) return { ok: false, message: "A work stream is required." };
  const { data, error } = await supabase
    .from("projects")
    .insert({
      user_id: user.id,
      name: input.name.trim(),
      work_stream_id: input.work_stream_id,
      status: input.status ?? "active",
      notes: input.notes ?? null,
    })
    .select("id")
    .single();
  if (error || !data) return { ok: false, message: error?.message ?? "Could not save." };
  revalidatePath("/tasks");
  return { ok: true, id: data.id };
}

export async function updateProjectAction(
  id: string,
  patch: Partial<ProjectInput>
): Promise<{ ok: boolean; message?: string }> {
  const { supabase } = await requireUser();
  const { error } = await supabase
    .from("projects")
    .update({
      ...(patch.name !== undefined ? { name: patch.name.trim() } : {}),
      ...(patch.work_stream_id !== undefined ? { work_stream_id: patch.work_stream_id } : {}),
      ...(patch.status !== undefined ? { status: patch.status } : {}),
      ...(patch.notes !== undefined ? { notes: patch.notes } : {}),
    })
    .eq("id", id);
  if (error) return { ok: false, message: error.message };
  revalidatePath("/tasks");
  return { ok: true };
}

export async function deleteProjectAction(
  id: string
): Promise<{ ok: boolean; message?: string }> {
  const { supabase } = await requireUser();
  // tasks.project_id is ON DELETE SET NULL, so tasks survive as unfiled.
  const { error } = await supabase.from("projects").delete().eq("id", id);
  if (error) return { ok: false, message: error.message };
  revalidatePath("/tasks");
  return { ok: true };
}
