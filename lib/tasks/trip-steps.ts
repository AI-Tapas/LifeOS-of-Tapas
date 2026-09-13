// The ONE loader for trip checklist steps. Home, the Tasks overview and the
// morning brief used to each run their own PostgREST embed
// (tasks ... trips(...)) over every step of every trip ever, which was the
// slowest query on the first screen and grew with every trip. This loads
// only trips still worth a line (ended within the last 30 days, or not yet
// ended) and then their steps, as two plain queries, and maps them once.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/database.types";
import type { TripStep } from "@/lib/tasks/trip-rollup";
import { addDays, civilKey, civilToday } from "@/lib/datetime";

// ponytail: 30 days keeps last month's trips visible for the invoice run;
// anything older has no open step left once the brief's sweep has run.
const KEEP_ENDED_DAYS = 30;

export async function loadTripSteps(
  supabase: SupabaseClient<Database>,
  // The cron routes use the service client, which bypasses RLS, so they
  // scope every query by user id explicitly. Cookie sessions pass nothing.
  userId?: string
): Promise<TripStep[]> {
  const cutoff = civilKey(addDays(civilToday(), -KEEP_ENDED_DAYS));
  let tripsQ = supabase
    .from("trips")
    .select("id, title, start_date, end_date, cities, session_label, session_date")
    .or(`end_date.is.null,end_date.gte.${cutoff}`);
  if (userId) tripsQ = tripsQ.eq("user_id", userId);
  const { data: trips } = await tripsQ;
  if (!trips?.length) return [];

  let stepsQ = supabase
    .from("tasks")
    .select("id, title, status, priority, due_ts, trip_id")
    .in("trip_id", trips.map((t) => t.id));
  if (userId) stepsQ = stepsQ.eq("user_id", userId);
  const { data: steps } = await stepsQ;

  const byId = new Map(trips.map((t) => [t.id, t]));
  return (steps ?? []).flatMap((s) => {
    const trip = s.trip_id ? byId.get(s.trip_id) : undefined;
    if (!trip) return [];
    return [
      {
        id: s.id,
        title: s.title,
        priority: s.priority,
        due_ts: s.due_ts,
        status: s.status,
        trip: {
          ...trip,
          // cities is jsonb, so it arrives as Json; the rollup wants strings.
          cities: Array.isArray(trip.cities) ? (trip.cities as string[]) : [],
        },
      },
    ];
  });
}
