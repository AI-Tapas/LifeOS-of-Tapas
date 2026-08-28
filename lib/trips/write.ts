// Trip, expense and bill writes with an explicit identity. Same pattern as
// lib/tasks/write.ts: every function takes the Supabase client and the user id
// to act as and reads no cookies, so one implementation serves three callers,
// the browser (cookie session), the in-app assistant, and the MCP connector.
//
// Bill rule enforced here, not by prompt: createBillDraft can only ever write
// status 'draft'. Marking a bill sent or paid is setBillStatus, which is
// reachable from the Trips screen alone. No assistant or connector tool calls
// it, and nothing in this file sends anything to anybody.

import {
  deriveLineItems,
  lineItemsTotal,
  nextBillNumber,
  parseLegs,
  type BillLineItem,
  type BillableExpense,
  type TripLeg,
} from "./bill.ts";
import { civilKey, civilToday } from "@/lib/datetime";
import type { Database, Json } from "@/lib/database.types";
import type { SupabaseClient } from "@supabase/supabase-js";

type Db = SupabaseClient<Database>;
type TripPurpose = Database["public"]["Enums"]["trip_purpose"];
type TripStatus = Database["public"]["Enums"]["trip_status"];
type ExpenseCategory = Database["public"]["Enums"]["trip_expense_category"];
type BillRecipient = Database["public"]["Enums"]["bill_recipient"];
type BillStatus = Database["public"]["Enums"]["bill_status"];

export type WriteResult =
  | { ok: true; id: string; note?: string }
  | { ok: false; message: string };

export interface TripInput {
  purpose: TripPurpose;
  title: string;
  work_stream_id: string;
  start_date?: string | null;
  end_date?: string | null;
  cities?: string[];
  legs?: TripLeg[];
  status?: TripStatus;
  billable_to?: string | null;
  notes?: string | null;
}

export interface ExpenseInput {
  trip_id: string;
  category: ExpenseCategory;
  amount: number;
  date: string;
  billable?: boolean;
  receipt_ref?: string | null;
}

// ---------------------------------------------------------------------------
// Trips
// ---------------------------------------------------------------------------
export async function createTrip(
  supabase: Db,
  userId: string,
  input: TripInput
): Promise<WriteResult> {
  if (!input.title.trim()) return { ok: false, message: "A trip title is required." };
  if (!input.work_stream_id) return { ok: false, message: "A work stream is required." };
  const dateFault = checkDates(input.start_date, input.end_date);
  if (dateFault) return { ok: false, message: dateFault };

  const { data, error } = await supabase
    .from("trips")
    .insert({
      user_id: userId,
      purpose: input.purpose,
      title: input.title.trim(),
      work_stream_id: input.work_stream_id,
      start_date: input.start_date ?? null,
      end_date: input.end_date ?? null,
      cities: (input.cities ?? []) as Json,
      legs: (input.legs ?? []) as unknown as Json,
      status: input.status ?? "planned",
      billable_to: input.billable_to ?? null,
      notes: input.notes ?? null,
    })
    .select("id")
    .single();
  if (error || !data) {
    return { ok: false, message: error?.message ?? "Could not save the trip." };
  }
  return { ok: true, id: data.id };
}

export async function updateTrip(
  supabase: Db,
  _userId: string,
  id: string,
  patch: Partial<TripInput>
): Promise<WriteResult> {
  if (patch.title !== undefined && !patch.title.trim()) {
    return { ok: false, message: "A trip title is required." };
  }
  const dateFault = checkDates(patch.start_date, patch.end_date);
  if (dateFault) return { ok: false, message: dateFault };

  const { error } = await supabase
    .from("trips")
    .update({
      ...(patch.purpose !== undefined ? { purpose: patch.purpose } : {}),
      ...(patch.title !== undefined ? { title: patch.title.trim() } : {}),
      ...(patch.work_stream_id !== undefined
        ? { work_stream_id: patch.work_stream_id }
        : {}),
      ...(patch.start_date !== undefined ? { start_date: patch.start_date } : {}),
      ...(patch.end_date !== undefined ? { end_date: patch.end_date } : {}),
      ...(patch.cities !== undefined ? { cities: patch.cities as Json } : {}),
      ...(patch.legs !== undefined ? { legs: patch.legs as unknown as Json } : {}),
      ...(patch.status !== undefined ? { status: patch.status } : {}),
      ...(patch.billable_to !== undefined ? { billable_to: patch.billable_to } : {}),
      ...(patch.notes !== undefined ? { notes: patch.notes } : {}),
    })
    .eq("id", id);
  if (error) return { ok: false, message: error.message };
  return { ok: true, id };
}

export async function deleteTrip(
  supabase: Db,
  _userId: string,
  id: string
): Promise<{ ok: boolean; message?: string }> {
  // Expenses cascade with the trip; a bill written from it survives with
  // trip_id set to null, which is the M1 FK policy on purpose: a claim
  // already made must not vanish because the trip record was tidied away.
  const { error } = await supabase.from("trips").delete().eq("id", id);
  if (error) return { ok: false, message: error.message };
  return { ok: true };
}

// Legs live in the trip's jsonb column, so appending one is a read, a push
// and a write. The caller gets the previous array back for undo.
export async function addTripLeg(
  supabase: Db,
  userId: string,
  tripId: string,
  leg: TripLeg
): Promise<{ ok: true; legs: TripLeg[]; previous: TripLeg[] } | { ok: false; message: string }> {
  const { data: trip } = await supabase
    .from("trips")
    .select("legs")
    .eq("id", tripId)
    .maybeSingle();
  if (!trip) return { ok: false, message: "Trip not found." };
  const previous = parseLegs(trip.legs);
  const legs = parseLegs([...previous, leg]);
  const r = await updateTrip(supabase, userId, tripId, { legs });
  if (!r.ok) return { ok: false, message: r.message };
  return { ok: true, legs, previous };
}

// ---------------------------------------------------------------------------
// Expenses
// ---------------------------------------------------------------------------
export async function addTripExpense(
  supabase: Db,
  userId: string,
  input: ExpenseInput
): Promise<WriteResult> {
  if (!input.trip_id) return { ok: false, message: "A trip is required." };
  if (!Number.isFinite(input.amount)) {
    return { ok: false, message: "An amount is required." };
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.date)) {
    return { ok: false, message: "A date as YYYY-MM-DD is required." };
  }
  const { data, error } = await supabase
    .from("trip_expenses")
    .insert({
      user_id: userId,
      trip_id: input.trip_id,
      category: input.category,
      amount: input.amount,
      date: input.date,
      billable: input.billable ?? false,
      // A reference string only: a folder name, a mail subject, a drive link
      // he pastes. The app never holds the receipt itself.
      receipt_ref: input.receipt_ref ?? null,
    })
    .select("id")
    .single();
  if (error || !data) {
    return { ok: false, message: error?.message ?? "Could not save the expense." };
  }
  return { ok: true, id: data.id };
}

export async function updateTripExpense(
  supabase: Db,
  _userId: string,
  id: string,
  patch: Partial<Omit<ExpenseInput, "trip_id">>
): Promise<WriteResult> {
  const { error } = await supabase
    .from("trip_expenses")
    .update({
      ...(patch.category !== undefined ? { category: patch.category } : {}),
      ...(patch.amount !== undefined ? { amount: patch.amount } : {}),
      ...(patch.date !== undefined ? { date: patch.date } : {}),
      ...(patch.billable !== undefined ? { billable: patch.billable } : {}),
      ...(patch.receipt_ref !== undefined ? { receipt_ref: patch.receipt_ref } : {}),
    })
    .eq("id", id);
  if (error) return { ok: false, message: error.message };
  return { ok: true, id };
}

export async function deleteTripExpense(
  supabase: Db,
  _userId: string,
  id: string
): Promise<{ ok: boolean; message?: string }> {
  const { error } = await supabase.from("trip_expenses").delete().eq("id", id);
  if (error) return { ok: false, message: error.message };
  return { ok: true };
}

export async function loadBillableExpenses(
  supabase: Db,
  tripId: string
): Promise<BillableExpense[]> {
  const { data } = await supabase
    .from("trip_expenses")
    .select("id, category, amount, date, billable")
    .eq("trip_id", tripId)
    .order("date");
  return (data ?? []) as BillableExpense[];
}

// ---------------------------------------------------------------------------
// Bills
// ---------------------------------------------------------------------------
export interface BillDraftInput {
  trip_id: string;
  bill_to?: BillRecipient;
  // The payer's name and address as it should print on the bill.
  bill_to_address?: string | null;
  number?: string | null;
  date?: string | null;
  line_items?: BillLineItem[];
  pdf_ref?: string | null;
}

// The ONLY function that creates a bill row, and it can only ever write
// status 'draft'. Nothing here sends anything: a draft is a document waiting
// for Tapas.
export async function createBillDraft(
  supabase: Db,
  userId: string,
  input: BillDraftInput
): Promise<WriteResult> {
  const { data: trip } = await supabase
    .from("trips")
    .select("id, title, work_stream_id, billable_to")
    .eq("id", input.trip_id)
    .maybeSingle();
  if (!trip) return { ok: false, message: "Trip not found." };

  const date = input.date ?? todayIsoDate();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return { ok: false, message: "A bill date as YYYY-MM-DD is required." };
  }

  const items =
    input.line_items && input.line_items.length
      ? input.line_items
      : deriveLineItems(await loadBillableExpenses(supabase, input.trip_id));
  if (!items.length) {
    return {
      ok: false,
      message: "This trip has no billable expenses yet, so there is nothing to bill.",
    };
  }

  const number = input.number?.trim() || (await suggestBillNumber(supabase, date));
  const { data, error } = await supabase
    .from("bills")
    .insert({
      user_id: userId,
      trip_id: trip.id,
      work_stream_id: trip.work_stream_id,
      bill_to: input.bill_to ?? "institute",
      bill_to_address: input.bill_to_address ?? trip.billable_to ?? null,
      number,
      date,
      line_items: items as unknown as Json,
      amount: lineItemsTotal(items),
      status: "draft",
      // A reference string, not a file: the PDF itself lives wherever he
      // saves it from the print view.
      pdf_ref: input.pdf_ref ?? number,
    })
    .select("id")
    .single();
  if (error || !data) {
    return {
      ok: false,
      message:
        error?.code === "23505"
          ? `Bill number ${number} already exists. Use another one.`
          : (error?.message ?? "Could not save the bill."),
    };
  }
  return { ok: true, id: data.id, note: number };
}

export async function updateBill(
  supabase: Db,
  _userId: string,
  id: string,
  patch: {
    number?: string;
    date?: string;
    bill_to?: BillRecipient;
    bill_to_address?: string | null;
    line_items?: BillLineItem[];
    pdf_ref?: string | null;
  }
): Promise<WriteResult> {
  const { error } = await supabase
    .from("bills")
    .update({
      ...(patch.number !== undefined ? { number: patch.number.trim() } : {}),
      ...(patch.date !== undefined ? { date: patch.date } : {}),
      ...(patch.bill_to !== undefined ? { bill_to: patch.bill_to } : {}),
      ...(patch.bill_to_address !== undefined
        ? { bill_to_address: patch.bill_to_address }
        : {}),
      ...(patch.line_items !== undefined
        ? {
            line_items: patch.line_items as unknown as Json,
            amount: lineItemsTotal(patch.line_items),
          }
        : {}),
      ...(patch.pdf_ref !== undefined ? { pdf_ref: patch.pdf_ref } : {}),
    })
    .eq("id", id);
  if (error) return { ok: false, message: error.message };
  return { ok: true, id };
}

// Marking a bill sent or paid is Tapas's own act in the app. Deliberately not
// reachable from any assistant or connector tool: the app never sends a bill,
// so only he can say that it went out.
export async function setBillStatus(
  supabase: Db,
  _userId: string,
  id: string,
  status: BillStatus
): Promise<WriteResult> {
  const { error } = await supabase.from("bills").update({ status }).eq("id", id);
  if (error) return { ok: false, message: error.message };
  return { ok: true, id };
}

export async function deleteBill(
  supabase: Db,
  _userId: string,
  id: string
): Promise<{ ok: boolean; message?: string }> {
  const { error } = await supabase.from("bills").delete().eq("id", id);
  if (error) return { ok: false, message: error.message };
  return { ok: true };
}

// Next number in the series for the bill date's financial year, using his
// stored prefix. Only ever a suggestion: the form leaves the field editable.
export async function suggestBillNumber(
  supabase: Db,
  date: string
): Promise<string> {
  const [{ data: profile }, { data: bills }] = await Promise.all([
    supabase.from("billing_profile").select("bill_prefix").maybeSingle(),
    supabase.from("bills").select("number"),
  ]);
  return nextBillNumber(
    profile?.bill_prefix?.trim() || "AICA",
    date,
    (bills ?? []).map((b) => b.number)
  );
}

// ---------------------------------------------------------------------------
function checkDates(
  start?: string | null,
  end?: string | null
): string | null {
  for (const [label, v] of [
    ["start date", start],
    ["end date", end],
  ] as const) {
    if (v && !/^\d{4}-\d{2}-\d{2}$/.test(v)) {
      return `The ${label} must be a date as YYYY-MM-DD.`;
    }
  }
  if (start && end && end < start) return "The end date is before the start date.";
  return null;
}

// Today's IST calendar date as YYYY-MM-DD.
function todayIsoDate(): string {
  return civilKey(civilToday());
}
