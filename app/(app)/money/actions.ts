"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import {
  syncObligationReminder,
  removeObligationReminder,
} from "@/lib/reminders/writer";
import type { Database } from "@/lib/database.types";

type Category = Database["public"]["Enums"]["obligation_category"];
type Frequency = Database["public"]["Enums"]["obligation_frequency"];

async function requireUser() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new Error("not signed in");
  return { supabase, user };
}

export interface ObligationInput {
  name: string;
  category: Category;
  amount?: number | null;
  variable_amount?: boolean;
  frequency: Frequency;
  due_day?: number | null;
  due_month?: number | null;
  autopay?: boolean;
  account_ref?: string | null;
  active?: boolean;
  notes?: string | null;
  remind_offsets?: number[];
}

export type ObligationResult =
  | { ok: true; id: string; reminderNote?: string }
  | { ok: false; message: string };

// A reminder needs a due day; a yearly reminder also needs a due month. Only
// enforced when the obligation is active (a reminder will be written).
function validateDue(input: {
  frequency: Frequency;
  due_day?: number | null;
  due_month?: number | null;
  active?: boolean;
}): string | null {
  if (!input.active) return null;
  if (!input.due_day || input.due_day < 1 || input.due_day > 31) {
    return "An active obligation needs a due day between 1 and 31.";
  }
  if (input.frequency === "yearly" && (!input.due_month || input.due_month < 1 || input.due_month > 12)) {
    return "A yearly obligation needs a due month.";
  }
  return null;
}

function reminderNote(o: { created: boolean; reason?: string } | null): string | undefined {
  if (o && !o.created && o.reason) return o.reason;
  return undefined;
}

export async function createObligationAction(
  input: ObligationInput
): Promise<ObligationResult> {
  const { supabase, user } = await requireUser();
  if (!input.name.trim()) return { ok: false, message: "A name is required." };
  const invalid = validateDue({ ...input, active: input.active ?? true });
  if (invalid) return { ok: false, message: invalid };

  const { data, error } = await supabase
    .from("recurring_obligations")
    .insert({
      user_id: user.id,
      name: input.name.trim(),
      category: input.category,
      amount: input.variable_amount ? null : input.amount ?? null,
      variable_amount: input.variable_amount ?? false,
      frequency: input.frequency,
      due_day: input.due_day ?? null,
      due_month: input.due_month ?? null,
      autopay: input.autopay ?? false,
      account_ref: input.account_ref ?? null,
      active: input.active ?? true,
      notes: input.notes ?? null,
      remind_offsets: input.remind_offsets ?? [7, 3, 1, 0],
    })
    .select("id")
    .single();
  if (error || !data) return { ok: false, message: error?.message ?? "Could not save." };

  let note: string | undefined;
  if (input.active ?? true) {
    try {
      note = reminderNote(await syncObligationReminder(user.id, data.id));
    } catch (e) {
      note = e instanceof Error ? e.message : undefined;
    }
  }
  revalidatePath("/money");
  return { ok: true, id: data.id, reminderNote: note };
}

export async function updateObligationAction(
  id: string,
  patch: ObligationInput
): Promise<ObligationResult> {
  const { supabase, user } = await requireUser();
  if (!patch.name.trim()) return { ok: false, message: "A name is required." };
  const invalid = validateDue({ ...patch, active: patch.active ?? true });
  if (invalid) return { ok: false, message: invalid };

  const { error } = await supabase
    .from("recurring_obligations")
    .update({
      name: patch.name.trim(),
      category: patch.category,
      amount: patch.variable_amount ? null : patch.amount ?? null,
      variable_amount: patch.variable_amount ?? false,
      frequency: patch.frequency,
      due_day: patch.due_day ?? null,
      due_month: patch.due_month ?? null,
      autopay: patch.autopay ?? false,
      account_ref: patch.account_ref ?? null,
      active: patch.active ?? true,
      notes: patch.notes ?? null,
      remind_offsets: patch.remind_offsets ?? [7, 3, 1, 0],
    })
    .eq("id", id);
  if (error) return { ok: false, message: error.message };

  let note: string | undefined;
  try {
    // syncObligationReminder writes the event when active, removes it when not.
    note = reminderNote(await syncObligationReminder(user.id, id));
  } catch (e) {
    note = e instanceof Error ? e.message : undefined;
  }
  revalidatePath("/money");
  return { ok: true, id, reminderNote: note };
}

export async function setObligationActiveAction(
  id: string,
  active: boolean
): Promise<ObligationResult> {
  const { supabase, user } = await requireUser();
  const { error } = await supabase
    .from("recurring_obligations")
    .update({ active })
    .eq("id", id);
  if (error) return { ok: false, message: error.message };
  let note: string | undefined;
  try {
    note = reminderNote(await syncObligationReminder(user.id, id));
  } catch (e) {
    note = e instanceof Error ? e.message : undefined;
  }
  revalidatePath("/money");
  return { ok: true, id, reminderNote: note };
}

export async function deleteObligationAction(
  id: string
): Promise<{ ok: boolean; message?: string }> {
  const { supabase, user } = await requireUser();
  // Remove the Google reminder event first, then the row (reminders cascade).
  await removeObligationReminder(user.id, id);
  const { error } = await supabase.from("recurring_obligations").delete().eq("id", id);
  if (error) return { ok: false, message: error.message };
  revalidatePath("/money");
  return { ok: true };
}
