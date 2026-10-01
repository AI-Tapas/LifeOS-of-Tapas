// Trip and expense writes with an explicit identity. Same pattern as
// lib/tasks/write.ts: every function takes the Supabase client and the user id
// to act as and reads no cookies, so one implementation serves three callers,
// the browser (cookie session), the in-app assistant, and the MCP connector.
//
// There is no bill write here any more, and that is the point of M6d. Life OS
// does not produce a bill: it holds the month accurately and hands it over
// (lib/trips/month.ts). Nothing in this file writes a bills row.

import {
  ONWARD_STEP_TITLE,
  defaultHotelArrangement,
  isHotelStepTitle,
  buildChecklist,
  type HotelArrangement,
} from "./checklist.ts";
import { parseLegs, stripHomeCity, type TripLeg } from "./core.ts";
import { createTask, setTaskStatus, updateTask } from "@/lib/tasks/write";
import { syncTripEvent, removeTripEvent } from "@/lib/reminders/writer";
import { syncFamilyTravel } from "@/lib/family/sync";
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
  session_label?: string | null;
  session_date?: string | null;
  legs?: TripLeg[];
  status?: TripStatus;
  // Who the trip is billed to, if anyone. Defaults to the monthly ICAI claim.
  bills_to?: BillsTo;
  notes?: string | null;
  // How the accommodation is handled. Left out on a create and the column
  // stays null, which readers resolve to his norm for that purpose. The app
  // sends a value; the connectors may omit it.
  hotel_arrangement?: HotelArrangement | null;
  // B28: sessions of one continuous journey share this id (null: none).
  journey_id?: string | null;
  // Not a column: when true, createTrip also seeds the standard travel
  // checklist against the new trip. The add-trip drawer sets it, and so does
  // the connector's with_checklist flag, through this one code path.
  with_checklist?: boolean;
}

export interface ExpenseInput {
  // B28: on an edit, trip_id MOVES the expense to another of his trips.
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

  // B28: a non-ICAI training is not on the ICAI claim (bills_to none unless
  // told otherwise) and defaults its hotel to the client when the client is
  // Cygnet, else his own booking. Only when the caller left them out.
  const client = await streamName(supabase, input.work_stream_id);
  const billsTo: BillsTo = input.bills_to ?? (input.purpose === "training" ? "none" : "icai_monthly");
  const hotel =
    input.hotel_arrangement ??
    (input.purpose === "training"
      ? defaultHotelArrangement(input.start_date ?? null, input.end_date ?? null, "training", client)
      : null);

  const { data, error } = await supabase
    .from("trips")
    .insert({
      user_id: userId,
      purpose: input.purpose,
      title: input.title.trim(),
      work_stream_id: input.work_stream_id,
      start_date: input.start_date ?? null,
      end_date: input.end_date ?? null,
      // B28: home is never a trip city.
      cities: stripHomeCity(input.cities ?? []) as Json,
      session_label: input.session_label ?? null,
      session_date: input.session_date ?? null,
      legs: (input.legs ?? []) as unknown as Json,
      status: input.status ?? "planned",
      bills_to: billsTo,
      notes: input.notes ?? null,
      hotel_arrangement: hotel,
      journey_id: input.journey_id ?? null,
    })
    .select("id")
    .single();
  if (error || !data) {
    return { ok: false, message: error?.message ?? "Could not save the trip." };
  }

  // M7a: one all-day event spanning the trip's dates, on the reminder-home
  // calendar. One per trip, never one per step. A failure here (ca.tapasnr
  // revoked, say) must not fail the trip write: the next save re-syncs it.
  if (input.start_date) await syncTripEvent(userId, data.id);
  // B29: the family travel calendar. Never throws, never blocks the write.
  await syncFamilyTravel(userId);

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
        cities: stripHomeCity(input.cities ?? []),
        hotel_arrangement: hotel,
        work_stream_id: input.work_stream_id,
        stream_name: client,
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
    // B28: the client's name for a client-arranged session.
    stream_name?: string | null;
  },
  // 'aed_only' seeds just the overseas-chapter invoice reminder, which is the
  // one step that must exist whether or not he wanted the travel checklist.
  scope: "all" | "aed_only" = "all"
): Promise<string[]> {
  const all = buildChecklist(trip, civilKey(civilToday()));
  const wanted = scope === "all" ? all : all.filter((s) => s.key === "aed");
  // Never a second copy. The trip screen's "Add checklist" used to seed a
  // fresh full set on every tap, so one trip carried "Book onward ticket"
  // three times. A step already on this trip, whatever its status, is kept
  // and not written again. Steps are known by title: there is no step_key
  // column, and the trip screen already tells them apart the same way.
  const { data: existing } = await supabase
    .from("tasks")
    .select("title")
    .eq("trip_id", tripId);
  const have = new Set((existing ?? []).map((t) => t.title.trim().toLowerCase()));
  const steps = wanted.filter((s) => !have.has(s.title.trim().toLowerCase()));
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
      // Routine travel admin does not interrupt him on the calendar (M7a).
      // The step decides its own mode: everything is in_app except the
      // overseas chapter AED invoice.
      reminder_mode: step.reminder_mode,
      // "app": a checklist step is routine travel admin the app generated,
      // never a judgment call. Recording it as his over-protects it (the
      // assistant will not re-rate it), which is the safe direction.
    }, "app");
    if (r.ok) ids.push(r.id);
  }
  return ids;
}

// B28: a work stream's name, which is the client of a client session.
async function streamName(supabase: Db, workStreamId: string): Promise<string | null> {
  const { data } = await supabase
    .from("work_streams")
    .select("name")
    .eq("id", workStreamId)
    .maybeSingle();
  return data?.name ?? null;
}

// The trip fields the checklist is derived from, read once.
async function checklistTrip(supabase: Db, tripId: string) {
  const { data: trip } = await supabase
    .from("trips")
    .select(
      "title, purpose, start_date, end_date, bills_to, cities, hotel_arrangement, work_stream_id"
    )
    .eq("id", tripId)
    .maybeSingle();
  if (!trip) return null;
  // cities is jsonb, so the generated type is Json: normalise it the same way
  // every other caller does.
  return {
    ...trip,
    cities: Array.isArray(trip.cities) ? (trip.cities as string[]) : [],
    stream_name: await streamName(supabase, trip.work_stream_id),
  };
}

// Adds the standard travel checklist to a trip that does not have it yet.
// Moved here from the trip screen's server action in B22 so the screen, the
// assistant and both connectors (add_trip_checklist) share it. seedTripChecklist
// never writes a step the trip already carries, so asking twice adds nothing.
export async function addTripChecklist(
  supabase: Db,
  userId: string,
  tripId: string
): Promise<{ ok: true; ids: string[] } | { ok: false; message: string }> {
  const trip = await checklistTrip(supabase, tripId);
  if (!trip) return { ok: false, message: "Trip not found." };
  const ids = await seedTripChecklist(supabase, userId, tripId, trip);
  if (!ids.length) {
    return {
      ok: false,
      message: trip.start_date
        ? "The checklist is already on this trip. Nothing was added."
        : "Set a start date on the trip first: the checklist counts back from it.",
    };
  }
  return { ok: true, ids };
}

// What a hotel-step sync changed, so undo can put each step back.
export interface HotelSyncChanges {
  created: string[];
  updated: { id: string; prev: { title: string; notes: string | null; due_ts: string | null } }[];
  dropped: { id: string; prev_status: string }[];
}

// Changing how the hotel is arranged does NOT rewrite the checklist by
// itself: the steps are ordinary tasks he may already have worked. This is
// the explicit "Update the checklist" act, and it only ever touches a step
// still sitting at 'todo' with the wording the app itself wrote. Anything he
// has completed, started, dropped or retitled is left exactly as it is, and
// the caller says so. Moved here from the trip screen's server action in B22
// (sync_trip_hotel_step), unchanged, plus the record of what it changed.
export async function syncTripHotelStep(
  supabase: Db,
  userId: string,
  tripId: string
): Promise<
  | { ok: true; note: string; changes: HotelSyncChanges }
  | { ok: false; message: string; changes: HotelSyncChanges }
> {
  const changes: HotelSyncChanges = { created: [], updated: [], dropped: [] };
  const trip = await checklistTrip(supabase, tripId);
  if (!trip) return { ok: false, message: "Trip not found.", changes };
  if (!trip.start_date) {
    return {
      ok: false,
      message: "Set a start date on the trip first: the checklist counts back from it.",
      changes,
    };
  }
  const steps = buildChecklist(trip, civilKey(civilToday()));
  const wantHotel = steps.find((s) => s.key === "hotel") ?? null;
  const wantOnward = steps.find((s) => s.key === "onward") ?? null;

  const { data: tasks } = await supabase
    .from("tasks")
    .select("id, title, status, notes, due_ts")
    .eq("trip_id", tripId);
  const rows = tasks ?? [];
  const hotelRow = rows.find((t) => isHotelStepTitle(t.title)) ?? null;
  const onwardRow = rows.find((t) => t.title === ONWARD_STEP_TITLE) ?? null;

  const done: string[] = [];
  let held = false;

  if (hotelRow && hotelRow.status !== "todo") {
    held = true;
  } else if (hotelRow && wantHotel) {
    const r = await updateTask(
      supabase,
      userId,
      hotelRow.id,
      {
        title: wantHotel.title,
        notes: wantHotel.note,
        due_ts: dueAt(wantHotel.due_date),
      },
      "app");
    if (!r.ok) return { ok: false, message: r.message, changes };
    changes.updated.push({
      id: hotelRow.id,
      prev: { title: hotelRow.title, notes: hotelRow.notes, due_ts: hotelRow.due_ts },
    });
    done.push("the hotel step now matches");
  } else if (hotelRow && !wantHotel) {
    // Dropped, never deleted: it stays visible as his own record that the
    // step was decided away rather than vanishing overnight.
    const r = await setTaskStatus(supabase, userId, hotelRow.id, "dropped");
    if (!r.ok) return { ok: false, message: r.message ?? "Could not drop the step.", changes };
    changes.dropped.push({ id: hotelRow.id, prev_status: hotelRow.status });
    done.push("the hotel step is dropped");
  } else if (!hotelRow && wantHotel && rows.length > 0) {
    const r = await createTask(
      supabase,
      userId,
      {
        title: wantHotel.title,
        notes: wantHotel.note,
        status: "todo",
        priority: "medium",
        due_ts: dueAt(wantHotel.due_date),
        work_stream_id: trip.work_stream_id,
        trip_id: tripId,
        source: "manual",
        // Routine travel admin, so it stays off the calendar (M7a). An
        // update never touches the mode: if he has changed how this trip
        // reminds him, that choice stands.
        reminder_mode: wantHotel.reminder_mode,
      },
      "app");
    if (!r.ok) return { ok: false, message: r.message, changes };
    changes.created.push(r.id);
    done.push("a hotel step is added");
  }

  // The onward step's note carries the night-before line, which a day return
  // makes wrong. Same rule: only while it is untouched.
  if (onwardRow && wantOnward && onwardRow.status === "todo" && onwardRow.notes !== wantOnward.note) {
    const r = await updateTask(supabase, userId, onwardRow.id, { notes: wantOnward.note }, "app");
    if (!r.ok) return { ok: false, message: r.message, changes };
    changes.updated.push({
      id: onwardRow.id,
      prev: { title: onwardRow.title, notes: onwardRow.notes, due_ts: onwardRow.due_ts },
    });
    done.push("the onward step's note is corrected");
  }

  if (held) {
    return {
      ok: false,
      message:
        "You have already worked the hotel step, so it is left alone. Change it yourself if it should read differently.",
      changes,
    };
  }
  if (!done.length) return { ok: true, note: "The checklist already matches.", changes };
  return { ok: true, note: `Updated: ${done.join(", ")}.`, changes };
}

export async function updateTrip(
  supabase: Db,
  userId: string,
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
      ...(patch.cities !== undefined ? { cities: stripHomeCity(patch.cities) as Json } : {}),
      ...(patch.session_label !== undefined ? { session_label: patch.session_label } : {}),
      ...(patch.session_date !== undefined ? { session_date: patch.session_date } : {}),
      ...(patch.legs !== undefined ? { legs: patch.legs as unknown as Json } : {}),
      ...(patch.status !== undefined ? { status: patch.status } : {}),
      ...(patch.bills_to !== undefined ? { bills_to: patch.bills_to } : {}),
      ...(patch.notes !== undefined ? { notes: patch.notes } : {}),
      ...(patch.hotel_arrangement !== undefined
        ? { hotel_arrangement: patch.hotel_arrangement }
        : {}),
      ...(patch.journey_id !== undefined ? { journey_id: patch.journey_id } : {}),
    })
    .eq("id", id);
  if (error) return { ok: false, message: error.message };
  // The calendar entry moves with the trip's dates, and goes when the start
  // date does. Cheap enough to re-sync on any save: it is one patch call.
  await syncTripEvent(userId, id);
  // B29: only a change to what the family calendar shows needs a sync.
  if (
    patch.legs !== undefined ||
    patch.status !== undefined ||
    patch.cities !== undefined ||
    patch.session_date !== undefined
  ) {
    await syncFamilyTravel(userId);
  }
  return { ok: true, id };
}

// B28. "Part of the same journey as <trip>": the other trip's journey id, or a
// fresh one written onto that trip too when it had none. Returns the id for
// the caller to put on the trip it is writing. The other trip must be his.
export async function resolveJourneyId(
  supabase: Db,
  userId: string,
  otherTripId: string
): Promise<{ ok: true; journey_id: string } | { ok: false; message: string }> {
  const { data: other } = await supabase
    .from("trips")
    .select("id, journey_id")
    .eq("id", otherTripId)
    .eq("user_id", userId)
    .maybeSingle();
  if (!other) return { ok: false, message: "The trip to share a journey with was not found." };
  if (other.journey_id) return { ok: true, journey_id: other.journey_id };
  const minted = crypto.randomUUID();
  const { error } = await supabase.from("trips").update({ journey_id: minted }).eq("id", other.id);
  if (error) return { ok: false, message: error.message };
  return { ok: true, journey_id: minted };
}

export async function deleteTrip(
  supabase: Db,
  userId: string,
  id: string
): Promise<{ ok: boolean; message?: string }> {
  // Remove the calendar entry first, then the trip, so no orphan event is
  // left behind: the same order deleteTask uses for a reminder.
  await removeTripEvent(userId, id);
  // Expenses cascade with the trip. Checklist steps do not: tasks.trip_id is
  // on delete set null, so work he still owes becomes an ordinary task again.
  const { error } = await supabase.from("trips").delete().eq("id", id);
  if (error) return { ok: false, message: error.message };
  // B29: the trip's family events lose their trip_id (set null) and the sync
  // deletes them from the family calendar.
  await syncFamilyTravel(userId);
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
  userId: string,
  id: string,
  patch: Partial<ExpenseInput>
): Promise<WriteResult> {
  // B28: moving an expense to another session. The target must be one of his
  // trips; no split, the whole expense moves.
  if (patch.trip_id !== undefined) {
    const { data: target } = await supabase
      .from("trips")
      .select("id")
      .eq("id", patch.trip_id)
      .eq("user_id", userId)
      .maybeSingle();
    if (!target) return { ok: false, message: "That trip was not found, so the expense stays where it is." };
  }
  const { error } = await supabase
    .from("trip_expenses")
    .update({
      ...(patch.trip_id !== undefined ? { trip_id: patch.trip_id } : {}),
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
