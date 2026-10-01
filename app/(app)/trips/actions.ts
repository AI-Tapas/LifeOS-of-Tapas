"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/auth/require-user";
import {
  addTripChecklist,
  addTripExpense,
  createTrip,
  syncTripHotelStep,
  deleteTrip,
  deleteTripExpense,
  resolveJourneyId,
  updateTrip,
  updateTripExpense,
  type ExpenseInput,
  type TripInput,
  type WriteResult,
} from "@/lib/trips/write";
import { updateTask } from "@/lib/tasks/write";

// Every action is a thin owner-session shell over lib/trips/write.ts, which
// the assistant and the MCP connector call with the same arguments.

// B28: sameJourneyAs is the id of a trip already on the journey this one
// joins. The server finds that trip's journey id, or starts one on both.
export async function createTripAction(
  input: TripInput,
  sameJourneyAs?: string | null
): Promise<WriteResult> {
  const { supabase, user } = await requireUser("/trips");
  if (sameJourneyAs) {
    const j = await resolveJourneyId(supabase, user.id, sameJourneyAs);
    if (!j.ok) return j;
    input = { ...input, journey_id: j.journey_id };
  }
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
  patch: Partial<TripInput>,
  sameJourneyAs?: string | null
): Promise<WriteResult> {
  const { supabase, user } = await requireUser("/trips");
  if (sameJourneyAs) {
    const j = await resolveJourneyId(supabase, user.id, sameJourneyAs);
    if (!j.ok) return j;
    patch = { ...patch, journey_id: j.journey_id };
  }
  const r = await updateTrip(supabase, user.id, id, patch);
  revalidatePath("/trips");
  revalidatePath("/trips/journey/[journey_id]", "page");
  revalidatePath("/trips/month");
  revalidatePath(`/trips/${id}`);
  return r;
}

// Adds the standard travel checklist to a trip that does not have it yet
// (the add-trip drawer offers it at creation; this is the same code path for
// a trip already in the list). The logic is lib/trips/write.ts
// addTripChecklist, shared with the add_trip_checklist tool since B22.
export async function addChecklistAction(tripId: string): Promise<WriteResult> {
  const { supabase, user } = await requireUser("/trips");
  const r = await addTripChecklist(supabase, user.id, tripId);
  revalidatePath("/trips");
  revalidatePath(`/trips/${tripId}`);
  revalidatePath("/tasks");
  revalidatePath("/");
  if (!r.ok) return r;
  return { ok: true, id: tripId, note: `${r.ids.length} steps added.` };
}

// The trip screen's "Update the checklist" after the hotel arrangement
// changed. The logic, and the rule that only an untouched 'todo' step with
// the app's own wording is ever changed, is lib/trips/write.ts
// syncTripHotelStep, shared with the sync_trip_hotel_step tool since B22.
export async function syncHotelStepAction(tripId: string): Promise<WriteResult> {
  const { supabase, user } = await requireUser("/trips");
  const r = await syncTripHotelStep(supabase, user.id, tripId);
  revalidatePath("/trips");
  revalidatePath(`/trips/${tripId}`);
  revalidatePath("/tasks");
  revalidatePath("/");
  if (!r.ok) return { ok: false, message: r.message };
  return { ok: true, id: tripId, note: r.note };
}

// M7a: one control for the whole trip, because that is how he thinks about
// it. Every step of this trip either interrupts him on the calendar or does
// not; there is no per-step fiddling. Each step goes through updateTask, so
// the calendar event is created or deleted by the normal path and neither
// direction can leave an orphan behind.
export async function setTripRemindersAction(
  tripId: string,
  mode: "calendar" | "in_app"
): Promise<WriteResult> {
  const { supabase, user } = await requireUser("/trips");
  const { data: steps } = await supabase
    .from("tasks")
    .select("id, status")
    .eq("trip_id", tripId);
  const live = (steps ?? []).filter(
    (t) => t.status !== "done" && t.status !== "dropped"
  );
  if (!live.length) {
    return { ok: false, message: "This trip has no open steps to change." };
  }
  let failed = 0;
  for (const step of live) {
    const r = await updateTask(supabase, user.id, step.id, { reminder_mode: mode }, "app");
    if (!r.ok) failed += 1;
  }
  revalidatePath("/trips");
  revalidatePath(`/trips/${tripId}`);
  revalidatePath("/tasks");
  revalidatePath("/");
  if (failed) {
    return {
      ok: false,
      message: `${failed} of ${live.length} steps could not be changed. Try again.`,
    };
  }
  const count = `${live.length} ${live.length === 1 ? "step" : "steps"}`;
  return {
    ok: true,
    id: tripId,
    note:
      mode === "calendar"
        ? `${count} now remind you on the calendar.`
        : `${count} now stay in the app and on your morning brief.`,
  };
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
  revalidatePath("/trips/journey/[journey_id]", "page");
  return r;
}

export async function updateExpenseAction(
  id: string,
  tripId: string,
  patch: Partial<ExpenseInput>
): Promise<WriteResult> {
  const { supabase, user } = await requireUser("/trips");
  const r = await updateTripExpense(supabase, user.id, id, patch);
  revalidatePath("/trips");
  revalidatePath("/trips/month");
  revalidatePath(`/trips/${tripId}`);
  // B28: a move changes two trips and the journey page that shows both.
  if (patch.trip_id) revalidatePath(`/trips/${patch.trip_id}`);
  revalidatePath("/trips/journey/[journey_id]", "page");
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
