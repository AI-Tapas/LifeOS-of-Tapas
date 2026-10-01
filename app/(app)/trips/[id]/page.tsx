import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import TripDetail, {
  type ChecklistRow,
  type ExpenseRow,
} from "@/components/trips/trip-detail";
import { parseLegs, shortDayLabel } from "@/lib/trips/core";
import { civilKey, civilToday } from "@/lib/datetime";
import type { TripFormValues } from "@/components/trips/trip-form";

export const dynamic = "force-dynamic";

export default async function TripDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const supabase = await createClient();

  const { data: trip } = await supabase
    .from("trips")
    .select(
      "id, purpose, title, work_stream_id, start_date, end_date, cities, legs, status, bills_to, notes, hotel_arrangement, session_label, session_date, journey_id, work_streams(name)"
    )
    .eq("id", id)
    .maybeSingle();
  if (!trip) notFound();

  const today = civilKey(civilToday());
  const [{ data: expenses }, { data: checklist }, { data: streams }, { data: others }] =
    await Promise.all([
      supabase
        .from("trip_expenses")
        .select("id, category, amount, date, billable, receipt_ref")
        .eq("trip_id", id)
        .order("date"),
      // The trip's checklist steps: ordinary tasks carrying this trip's id.
      supabase
        .from("tasks")
        .select("id, title, notes, status, due_ts, reminder_mode")
        .eq("trip_id", id)
        .order("due_ts", { ascending: true, nullsFirst: false }),
      supabase
        .from("work_streams")
        .select("id, name")
        .eq("active", true)
        .order("name"),
      // B28: the trips he could join a journey with. Not finished yet, or
      // already on a journey.
      supabase
        .from("trips")
        .select("id, title, cities, start_date, end_date, journey_id")
        .neq("id", id)
        .or(`end_date.gte.${today},end_date.is.null`)
        .order("start_date", { ascending: true, nullsFirst: false }),
    ]);

  const values: TripFormValues = {
    id: trip.id,
    purpose: trip.purpose,
    title: trip.title,
    work_stream_id: trip.work_stream_id,
    start_date: trip.start_date,
    end_date: trip.end_date,
    cities: Array.isArray(trip.cities) ? (trip.cities as string[]) : [],
    status: trip.status,
    bills_to: trip.bills_to,
    notes: trip.notes,
    hotel_arrangement: trip.hotel_arrangement,
    journey_id: trip.journey_id,
  };

  return (
    <main>
      <TripDetail
        trip={values}
        streamName={(trip.work_streams as { name: string } | null)?.name ?? ""}
        legs={parseLegs(trip.legs)}
        checklist={(checklist ?? []) as ChecklistRow[]}
        expenses={((expenses ?? []) as ExpenseRow[]).map((e) => ({
          ...e,
          amount: Number(e.amount),
        }))}
        workStreams={streams ?? []}
        todayKey={today}
        journeyChoices={(others ?? []).map((o) => ({
          id: o.id,
          label: `${(Array.isArray(o.cities) && o.cities.length ? (o.cities as string[]).join(", ") : o.title)}${
            o.start_date ? `, ${shortDayLabel(o.start_date)}` : ""
          }`,
        }))}
      />
    </main>
  );
}
