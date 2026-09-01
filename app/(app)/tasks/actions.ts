"use server";

// Thin cookie-session wrappers over lib/tasks/write.ts. The logic lives there
// so the browser, the in-app assistant and the MCP connector all share one
// implementation; only the identity differs.

import { revalidatePath } from "next/cache";
import {
  createTask,
  updateTask,
  setTaskStatus,
  deleteTask,
  type TaskInput,
  type TaskResult,
} from "@/lib/tasks/write";
import type { Database } from "@/lib/database.types";
import { requireUser } from "@/lib/auth/require-user";

// NOTE: never re-export types from a "use server" module. Next.js treats
// every export here as a server action and emits registerServerReference
// for it, so a type-only export becomes a runtime ReferenceError the
// moment this module is loaded. Import these types from
// @/lib/tasks/write instead.

type TaskStatus = Database["public"]["Enums"]["task_status"];

export async function createTaskAction(input: TaskInput): Promise<TaskResult> {
  const { supabase, user } = await requireUser("/tasks");
  // "app": his own form. This is the ONLY origin that records a priority
  // as his, and it is why nothing the assistant does can overwrite one.
  const r = await createTask(supabase, user.id, input, "app");
  if (r.ok) revalidatePath("/tasks");
  return r;
}

export async function updateTaskAction(
  id: string,
  patch: Partial<TaskInput>
): Promise<TaskResult> {
  const { supabase, user } = await requireUser("/tasks");
  const r = await updateTask(supabase, user.id, id, patch, "app");
  if (r.ok) revalidatePath("/tasks");
  return r;
}

export async function setTaskStatusAction(
  id: string,
  status: TaskStatus
): Promise<TaskResult> {
  const { supabase, user } = await requireUser("/tasks");
  const t = await setTaskStatus(supabase, user.id, id, status);
  if (!t.ok) return { ok: false, message: t.message ?? "Could not update the task." };
  revalidatePath("/tasks");
  return { ok: true, id, reminderNote: t.reminderNote };
}

export async function deleteTaskAction(
  id: string
): Promise<{ ok: boolean; message?: string }> {
  const { supabase, user } = await requireUser("/tasks");
  const r = await deleteTask(supabase, user.id, id);
  if (r.ok) revalidatePath("/tasks");
  return r;
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
  const { supabase, user } = await requireUser("/tasks");
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
  const { supabase } = await requireUser("/tasks");
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
  const { supabase } = await requireUser("/tasks");
  // tasks.project_id is ON DELETE SET NULL, so tasks survive as unfiled.
  const { error } = await supabase.from("projects").delete().eq("id", id);
  if (error) return { ok: false, message: error.message };
  revalidatePath("/tasks");
  return { ok: true };
}
