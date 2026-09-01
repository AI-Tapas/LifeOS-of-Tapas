// Trip and expense writes with an explicit identity. Same pattern as
// lib/tasks/write.ts: every function takes the Supabase client and the user id
// to act as and reads no cookies, so one implementation serves three callers,
// the browser (cookie session), the in-app assistant, and the MCP connector.
//
// There is no bill write here any more, and that is the point of M6d. Life OS
// does not produce a bill: it holds the month accurately and hands it over
// (lib/trips/month.ts). Nothing in this file writes a bills row.

import { buildChecklist, type HotelArrangement } from "./checklist.ts";
import { parseLegs, type TripLeg } from "./bill.ts";
import { createTask } from "@/lib/tasks/write";
import { civilKey, civilToday, istInstant } from "@/lib/datetime";
import type { Database, Json } from "@/lib/database.types";
import type { SupabaseClient } from "@supabase/supabase-js";

type Db = SupabaseClient<Database>;
type TripPurpose = Database["public"]["Enums"]["trip_purpose"];
type TripStatus = Database["public"]["Enums"]["trip_status"];
type ExpenseCategory = Database["public"]["Enums"]["trip_expense_category"];
type BillsTo = Database["public"]["Enums"]["trip_bills_to"];

export type WriteResult =
  | { ok: true; id: string; note?: string; checklistTaskIds?: string[] }
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
  // Who the trip is billed to, if anyone. Defaults to the monthly ICAI claim.
  bills_to?: BillsTo;
  notes?: string | null;
  // How the accommodation is handled. Left out on a create and the column
  // stays null, which readers resolve to his norm for that purpose. The app
  // sends a value; the connectors may omit it.
  hotel_arrangement?: HotelArrangement | null;
  // Not a column: when true, createTrip also seeds the standard travel
  // checklist against the new trip. The add-trip drawer sets it, and so does
  // the connector's with_checklist flag, through this one code path.
  with_checklist?: boolean;
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
      bills_to: input.bills_to ?? "icai_monthly",
      notes: input.notes ?? null,
      hotel_arrangement: input.hotel_arrangement ?? null,
    })
    .select("id")
    .single();
  if (error || !data) {
    return { ok: false, message: error?.message ?? "Could not save the trip." };
  }

  const billsTo = input.bills_to ?? "icai_monthly";
  // An overseas chapter trip always gets its AED reminder, checklist asked
  // for or not: that invoice is raised once or twice a year and forgetting it
  // is the stated risk. Everything else only arrives when he asks for it.
  if (input.with_checklist || billsTo === "chapter_aed") {
    const seeded = await seedTripChecklist(
      supabase,
      userId,
      data.id,
      {
        title: input.title.trim(),
        purpose: input.purpose,
        start_date: input.start_date ?? null,
        end_date: input.end_date ?? null,
        bills_to: billsTo,
        cities: input.cities ?? [],
        hotel_arrangement: input.hotel_arrangement ?? null,
        work_stream_id: input.work_stream_id,
      },
      input.with_checklist ? "all" : "aed_only"
    );
    return {
      ok: true,
      id: data.id,
      note: seeded.length
        ? `${seeded.length} checklist ${seeded.length === 1 ? "step" : "steps"} added.`
        : "No checklist: the trip has no start date to count back from.",
      checklistTaskIds: seeded,
    };
  }
  return { ok: true, id: data.id };
}

// Seeds the standard travel checklist as ordinary tasks carrying trip_id.
// The ONE seeding path: the drawer, the assistant and both connectors all
// arrive here, so the steps and their dates can never differ between them.
// Each step goes through createTask, so each gets its calendar reminder like
// any other dated task.
export async function seedTripChecklist(
  supabase: Db,
  userId: string,
  tripId: string,
  trip: {
    title: string;
    purpose: TripPurpose;
    start_date: string | null;
    end_date: string | null;
    bills_to: BillsTo;
    cities: string[];
    hotel_arrangement?: HotelArrangement | null;
    work_stream_id: string;
  },
  // 'aed_only' seeds just the overseas-chapter invoice reminder, which is the
  // one step that must exist whether or not he wanted the travel checklist.
  scope: "all" | "aed_only" = "all"
): Promise<string[]> {
  const all = buildChecklist(trip, civilKey(civilToday()));
  const steps = scope === "all" ? all : all.filter((s) => s.key === "aed");
  const ids: string[] = [];
  for (const step of steps) {
    const r = await createTask(supabase, userId, {
      title: step.title,
      notes: step.note,
      status: "todo",
      priority: "medium",
      // Travel admin is a morning job, so it falls due at 9:30 am IST like
      // every other task due date in the app.
      due_ts: dueAt(step.due_date),
      work_stream_id: trip.work_stream_id,
      trip_id: tripId,
      source: "manual",
      // "app": a checklist step is routine travel admin the app generated,
      // never a judgment call. Recording it as his over-protects it (the
      // assistant will not re-rate it), which is the safe direction.
    }, "app");
    if (r.ok) ids.push(r.id);
  }
  return ids;
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
      ...(patch.bills_to !== undefined ? { bills_to: patch.bills_to } : {}),
      ...(patch.notes !== undefined ? { notes: patch.notes } : {}),
      ...(patch.hotel_arrangement !== undefined
        ? { hotel_arrangement: patch.hotel_arrangement }
        : {}),
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
  // Expenses cascade with the trip. Checklist steps do not: tasks.trip_id is
  // on delete set null, so work he still owes becomes an ordinary task again.
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

// A YYYY-MM-DD checklist date at 9:30 am IST, the app's standard due time.
// Exported so the trip screen's hotel-step sync dates a step exactly as the
// seeder does.
export function dueAt(dateOnly: string): string {
  const [y, m, d] = dateOnly.split("-").map(Number);
  return istInstant({ y, m, d }, 9, 30).toISOString();
}
