"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/auth/require-user";
import {
  addTripExpense,
  createTrip,
  seedTripChecklist,
  deleteTrip,
  deleteTripExpense,
  updateTrip,
  updateTripExpense,
  type ExpenseInput,
  type TripInput,
  type WriteResult,
} from "@/lib/trips/write";

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
    .select("title, purpose, start_date, end_date, bills_to, cities, work_stream_id")
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
