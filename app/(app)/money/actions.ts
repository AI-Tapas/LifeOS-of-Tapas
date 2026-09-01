"use server";

import { revalidatePath } from "next/cache";
import {
  syncObligationReminder,
  removeObligationReminder,
  syncFinanceReminder,
  removeFinanceReminder,
} from "@/lib/reminders/writer";
import { customStepDays, parseDateKey } from "@/lib/reminders/core";
import type { Database } from "@/lib/database.types";
import { requireUser } from "@/lib/auth/require-user";
import type { FinanceKind } from "@/lib/money/investments";

type Category = Database["public"]["Enums"]["obligation_category"];
type Frequency = Database["public"]["Enums"]["obligation_frequency"];
type KeyDateType = Database["public"]["Enums"]["finance_key_date_type"];

export interface ObligationInput {
  name: string;
  category: Category;
  amount?: number | null;
  variable_amount?: boolean;
  frequency: Frequency;
  due_day?: number | null;
  due_month?: number | null;
  interval_rule?: string | null;
  anchor_date?: string | null;
  autopay?: boolean;
  account_ref?: string | null;
  active?: boolean;
  notes?: string | null;
  remind_offsets?: number[];
}

export type ObligationResult =
  | { ok: true; id: string; reminderNote?: string }
  | { ok: false; message: string };

// A reminder needs a due day; a yearly reminder also needs a due month; a
// custom (sub-monthly) series needs a readable rule and a date to count from,
// because "every ten days" is not a series until you say from when. Only
// enforced when the obligation is active, since only then is a reminder
// written. The database carries no check constraint for the custom pair: the
// enum value is added in the same migration and Postgres refuses to have a
// constraint use it there, so this is the enforcement, beside the writer's.
function validateDue(input: {
  frequency: Frequency;
  due_day?: number | null;
  due_month?: number | null;
  interval_rule?: string | null;
  anchor_date?: string | null;
  active?: boolean;
}): string | null {
  if (!input.active) return null;
  if (input.frequency === "custom") {
    try {
      customStepDays(input.interval_rule);
      parseDateKey(input.anchor_date);
    } catch (e) {
      return e instanceof Error ? e.message : "That series cannot be read.";
    }
    return null;
  }
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
  const { supabase, user } = await requireUser("/money");
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
      due_day: input.frequency === "custom" ? null : input.due_day ?? null,
      due_month: input.frequency === "custom" ? null : input.due_month ?? null,
      interval_rule: input.frequency === "custom" ? input.interval_rule ?? null : null,
      anchor_date: input.frequency === "custom" ? input.anchor_date ?? null : null,
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
  const { supabase, user } = await requireUser("/money");
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
      due_day: patch.frequency === "custom" ? null : patch.due_day ?? null,
      due_month: patch.frequency === "custom" ? null : patch.due_month ?? null,
      interval_rule: patch.frequency === "custom" ? patch.interval_rule ?? null : null,
      anchor_date: patch.frequency === "custom" ? patch.anchor_date ?? null : null,
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
  const { supabase, user } = await requireUser("/money");
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
  const { supabase, user } = await requireUser("/money");
  // Remove the Google reminder event first, then the row (reminders cascade).
  await removeObligationReminder(user.id, id);
  const { error } = await supabase.from("recurring_obligations").delete().eq("id", id);
  if (error) return { ok: false, message: error.message };
  revalidatePath("/money");
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Investments (M7b)
// ---------------------------------------------------------------------------
// The fields are deliberately few: what it is, where it is held as a short
// human label, what it is worth, and one date. There is no account number, no
// folio number and no upload, here or in the schema, and scripts/m7b.test.ts
// fails if a field that looks like one ever appears.
export interface HoldingInput {
  kind: FinanceKind;
  name: string;
  institution?: string | null;
  value?: number | null;
  key_date?: string | null;
  key_date_type?: KeyDateType | null;
  remind?: boolean;
  notes?: string | null;
}

export type HoldingResult =
  | { ok: true; id: string; reminderNote?: string }
  | { ok: false; message: string };

function validateHolding(input: HoldingInput): string | null {
  if (!input.name.trim()) return "A name is required.";
  if (input.key_date && !input.key_date_type) {
    return "Say whether that date is a maturity or a review.";
  }
  if (input.key_date_type && !input.key_date) {
    return "That kind of date needs a date.";
  }
  if (input.value != null && (!Number.isFinite(input.value) || input.value < 0)) {
    return "The value must be a number.";
  }
  return null;
}

function holdingRow(input: HoldingInput) {
  return {
    kind: input.kind,
    name: input.name.trim(),
    institution: input.institution?.trim() || null,
    value: input.value ?? null,
    key_date: input.key_date || null,
    key_date_type: input.key_date ? input.key_date_type ?? null : null,
    remind: input.remind ?? true,
    notes: input.notes?.trim() || null,
  };
}

export async function createHoldingAction(input: HoldingInput): Promise<HoldingResult> {
  const { supabase, user } = await requireUser("/money");
  const invalid = validateHolding(input);
  if (invalid) return { ok: false, message: invalid };

  const { data, error } = await supabase
    .from("finance_items")
    .insert({ user_id: user.id, ...holdingRow(input) })
    .select("id")
    .single();
  if (error || !data) return { ok: false, message: error?.message ?? "Could not save." };

  let note: string | undefined;
  try {
    // Writes the calendar event on a maturity, and nothing on a review date.
    note = reminderNote(await syncFinanceReminder(user.id, data.id));
  } catch (e) {
    note = e instanceof Error ? e.message : undefined;
  }
  revalidatePath("/money");
  revalidatePath("/");
  return { ok: true, id: data.id, reminderNote: note };
}

export async function updateHoldingAction(
  id: string,
  patch: HoldingInput
): Promise<HoldingResult> {
  const { supabase, user } = await requireUser("/money");
  const invalid = validateHolding(patch);
  if (invalid) return { ok: false, message: invalid };

  const { error } = await supabase
    .from("finance_items")
    .update(holdingRow(patch))
    .eq("id", id);
  if (error) return { ok: false, message: error.message };

  let note: string | undefined;
  try {
    // The one sync covers both directions: turning a maturity into a review
    // date removes the event it had, through the same removal path.
    note = reminderNote(await syncFinanceReminder(user.id, id));
  } catch (e) {
    note = e instanceof Error ? e.message : undefined;
  }
  revalidatePath("/money");
  revalidatePath("/");
  return { ok: true, id, reminderNote: note };
}

export async function deleteHoldingAction(
  id: string
): Promise<{ ok: boolean; message?: string }> {
  const { supabase, user } = await requireUser("/money");
  await removeFinanceReminder(user.id, id);
  const { error } = await supabase.from("finance_items").delete().eq("id", id);
  if (error) return { ok: false, message: error.message };
  revalidatePath("/money");
  revalidatePath("/");
  return { ok: true };
}
