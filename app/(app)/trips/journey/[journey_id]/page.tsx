import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import JourneyView, { type JourneySessionRow } from "@/components/trips/journey-view";
import { parseLegs } from "@/lib/trips/core";
import { civilKey, civilToday } from "@/lib/datetime";

export const dynamic = "force-dynamic";

// B28. One continuous journey: every session that shares the journey_id, all
// their legs in date order, and all their expenses in one table.
export default async function JourneyPage({
  params,
}: {
  params: Promise<{ journey_id: string }>;
}) {
  const { journey_id } = await params;
  const supabase = await createClient();

  const { data: trips } = await supabase
    .from("trips")
    .select(
      "id, purpose, title, start_date, end_date, cities, legs, bills_to, session_label, session_date, journey_id, work_streams(name)"
    )
    .eq("journey_id", journey_id)
    .order("start_date", { ascending: true, nullsFirst: false });
  if (!trips?.length) notFound();

  const { data: expenses } = await supabase
    .from("trip_expenses")
    .select("id, trip_id, category, amount, date, billable, receipt_ref")
    .in(
      "trip_id",
      trips.map((t) => t.id)
    )
    .order("date");

  const sessions: JourneySessionRow[] = trips.map((t) => ({
    id: t.id,
    journey_id: t.journey_id,
    purpose: t.purpose,
    title: t.title,
    start_date: t.start_date,
    end_date: t.end_date,
    session_label: t.session_label,
    session_date: t.session_date,
    bills_to: t.bills_to,
    cities: Array.isArray(t.cities) ? (t.cities as string[]) : [],
    legs: parseLegs(t.legs),
    stream_name: (t.work_streams as { name: string } | null)?.name ?? "",
  }));

  return (
    <main>
      <JourneyView
        sessions={sessions}
        expenses={(expenses ?? []).map((e) => ({ ...e, amount: Number(e.amount) }))}
        todayKey={civilKey(civilToday())}
      />
    </main>
  );
}
