"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/auth/require-user";
import {
  addTripExpense,
  createTrip,
  dueAt,
  seedTripChecklist,
  deleteTrip,
  deleteTripExpense,
  updateTrip,
  updateTripExpense,
  type ExpenseInput,
  type TripInput,
  type WriteResult,
} from "@/lib/trips/write";
import { createTask, setTaskStatus, updateTask } from "@/lib/tasks/write";
import {
  HOTEL_STEP_TITLES,
  ONWARD_STEP_TITLE,
  buildChecklist,
} from "@/lib/trips/checklist";
import { civilKey, civilToday } from "@/lib/datetime";

// Every action is a thin owner-session shell over lib/trips/write.ts, which
// the assistant and the MCP connector call with the same arguments.

export async function createTripAction(input: TripInput): Promise<WriteResult> {
  const { supabase, user } = await requireUser("/trips");
  const r = await createTrip(supabase, user.id, input);
  revalidatePath("/trips");
  revalidatePath("/trips/month");
  // A chapter_aed trip seeds its AED invoice reminder whether or not the
  // checklist was asked for, so the task surfaces revalidate either way.
  revalidatePath("/tasks");
  revalidatePath("/");
  return r;
}

export async function updateTripAction(
  id: string,
  patch: Partial<TripInput>
): Promise<WriteResult> {
  const { supabase, user } = await requireUser("/trips");
  const r = await updateTrip(supabase, user.id, id, patch);
  revalidatePath("/trips");
  revalidatePath("/trips/month");
  revalidatePath(`/trips/${id}`);
  return r;
}

// Adds the standard travel checklist to a trip that does not have it yet
// (the add-trip drawer offers it at creation; this is the same code path for
// a trip already in the list).
export async function addChecklistAction(tripId: string): Promise<WriteResult> {
  const { supabase, user } = await requireUser("/trips");
  const { data: trip } = await supabase
    .from("trips")
    .select(
      "title, purpose, start_date, end_date, bills_to, cities, hotel_arrangement, work_stream_id"
    )
    .eq("id", tripId)
    .maybeSingle();
  if (!trip) return { ok: false, message: "Trip not found." };
  const ids = await seedTripChecklist(supabase, user.id, tripId, {
    ...trip,
    cities: Array.isArray(trip.cities) ? (trip.cities as string[]) : [],
  });
  revalidatePath("/trips");
  revalidatePath(`/trips/${tripId}`);
  revalidatePath("/tasks");
  revalidatePath("/");
  if (!ids.length) {
    return {
      ok: false,
      message: "Set a start date on the trip first: the checklist counts back from it.",
    };
  }
  return { ok: true, id: tripId, note: `${ids.length} steps added.` };
}

// Changing how the hotel is arranged does NOT rewrite the checklist by
// itself: the steps are ordinary tasks he may already have worked. The trip
// screen offers this instead, and it only ever touches a step still sitting
// at 'todo' with the wording the app itself wrote. Anything he has completed,
// started, dropped or retitled is left exactly as it is, and the caller says
// so on screen.
export async function syncHotelStepAction(tripId: string): Promise<WriteResult> {
  const { supabase, user } = await requireUser("/trips");
  const { data: trip } = await supabase
    .from("trips")
    .select(
      "title, purpose, start_date, end_date, bills_to, cities, hotel_arrangement, work_stream_id"
    )
    .eq("id", tripId)
    .maybeSingle();
  if (!trip) return { ok: false, message: "Trip not found." };

  const steps = buildChecklist(
    // cities is jsonb, so the generated type is Json: normalise it the same
    // way every other caller does.
    { ...trip, cities: Array.isArray(trip.cities) ? (trip.cities as string[]) : [] },
    civilKey(civilToday())
  );
  if (!trip.start_date) {
    return {
      ok: false,
      message: "Set a start date on the trip first: the checklist counts back from it.",
    };
  }
  const wantHotel = steps.find((s) => s.key === "hotel") ?? null;
  const wantOnward = steps.find((s) => s.key === "onward") ?? null;

  const { data: tasks } = await supabase
    .from("tasks")
    .select("id, title, status, notes, due_ts")
    .eq("trip_id", tripId);
  const rows = tasks ?? [];
  const hotelRow = rows.find((t) => HOTEL_STEP_TITLES.includes(t.title)) ?? null;
  const onwardRow = rows.find((t) => t.title === ONWARD_STEP_TITLE) ?? null;

  const done: string[] = [];
  let held = false;

  if (hotelRow && hotelRow.status !== "todo") {
    held = true;
  } else if (hotelRow && wantHotel) {
    const r = await updateTask(
      supabase,
      user.id,
      hotelRow.id,
      {
        title: wantHotel.title,
        notes: wantHotel.note,
        due_ts: dueAt(wantHotel.due_date),
      },
      "app"
    );
    if (!r.ok) return { ok: false, message: r.message };
    done.push("the hotel step now matches");
  } else if (hotelRow && !wantHotel) {
    // Dropped, never deleted: it stays visible as his own record that the
    // step was decided away rather than vanishing overnight.
    const r = await setTaskStatus(supabase, user.id, hotelRow.id, "dropped");
    if (!r.ok) return { ok: false, message: r.message ?? "Could not drop the step." };
    done.push("the hotel step is dropped");
  } else if (!hotelRow && wantHotel && rows.length > 0) {
    const r = await createTask(
      supabase,
      user.id,
      {
        title: wantHotel.title,
        notes: wantHotel.note,
        status: "todo",
        priority: "medium",
        due_ts: dueAt(wantHotel.due_date),
        work_stream_id: trip.work_stream_id,
        trip_id: tripId,
        source: "manual",
      },
      "app"
    );
    if (!r.ok) return { ok: false, message: r.message };
    done.push("a hotel step is added");
  }

  // The onward step's note carries the night-before line, which a day return
  // makes wrong. Same rule: only while it is untouched.
  if (onwardRow && wantOnward && onwardRow.status === "todo" && onwardRow.notes !== wantOnward.note) {
    const r = await updateTask(
      supabase,
      user.id,
      onwardRow.id,
      { notes: wantOnward.note },
      "app"
    );
    if (!r.ok) return { ok: false, message: r.message };
    done.push("the onward step's note is corrected");
  }

  revalidatePath("/trips");
  revalidatePath(`/trips/${tripId}`);
  revalidatePath("/tasks");
  revalidatePath("/");

  if (held) {
    return {
      ok: false,
      message:
        "You have already worked the hotel step, so it is left alone. Change it yourself if it should read differently.",
    };
  }
  if (!done.length) {
    return { ok: true, id: tripId, note: "The checklist already matches." };
  }
  return { ok: true, id: tripId, note: `Updated: ${done.join(", ")}.` };
}

export async function deleteTripAction(
  id: string
): Promise<{ ok: boolean; message?: string }> {
  const { supabase, user } = await requireUser("/trips");
  const r = await deleteTrip(supabase, user.id, id);
  revalidatePath("/trips");
  return r;
}

export async function addExpenseAction(input: ExpenseInput): Promise<WriteResult> {
  const { supabase, user } = await requireUser("/trips");
  const r = await addTripExpense(supabase, user.id, input);
  revalidatePath("/trips");
  revalidatePath("/trips/month");
  revalidatePath(`/trips/${input.trip_id}`);
  return r;
}

export async function updateExpenseAction(
  id: string,
  tripId: string,
  patch: Partial<Omit<ExpenseInput, "trip_id">>
): Promise<WriteResult> {
  const { supabase, user } = await requireUser("/trips");
  const r = await updateTripExpense(supabase, user.id, id, patch);
  revalidatePath("/trips");
  revalidatePath("/trips/month");
  revalidatePath(`/trips/${tripId}`);
  return r;
}

export async function deleteExpenseAction(
  id: string,
  tripId: string
): Promise<{ ok: boolean; message?: string }> {
  const { supabase, user } = await requireUser("/trips");
  const r = await deleteTripExpense(supabase, user.id, id);
  revalidatePath("/trips");
  revalidatePath("/trips/month");
  revalidatePath(`/trips/${tripId}`);
  return r;
}
