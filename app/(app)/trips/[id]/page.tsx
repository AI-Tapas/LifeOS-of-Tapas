import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import TripDetail, {
  type ChecklistRow,
  type ExpenseRow,
} from "@/components/trips/trip-detail";
import { parseLegs } from "@/lib/trips/bill";
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
      "id, purpose, title, work_stream_id, start_date, end_date, cities, legs, status, bills_to, notes, hotel_arrangement, work_streams(name)"
    )
    .eq("id", id)
    .maybeSingle();
  if (!trip) notFound();

  const today = civilKey(civilToday());
  const [{ data: expenses }, { data: checklist }, { data: streams }] =
    await Promise.all([
      supabase
        .from("trip_expenses")
        .select("id, category, amount, date, billable, receipt_ref")
        .eq("trip_id", id)
        .order("date"),
      // The trip's checklist steps: ordinary tasks carrying this trip's id.
      supabase
        .from("tasks")
        .select("id, title, notes, status, due_ts")
        .eq("trip_id", id)
        .order("due_ts", { ascending: true, nullsFirst: false }),
      supabase
        .from("work_streams")
        .select("id, name")
        .eq("active", true)
        .order("name"),
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
      />
    </main>
  );
}
