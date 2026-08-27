import { createClient } from "@/lib/supabase/server";
import TripsView, {
  type TripRow,
  type WorkStreamRow,
} from "@/components/trips/trips-view";
import { civilKey, civilToday } from "@/lib/datetime";

export const dynamic = "force-dynamic";

export default async function TripsPage() {
  const supabase = await createClient();
  const [{ data: trips }, { data: expenses }, { data: bills }, { data: streams }] =
    await Promise.all([
      supabase
        .from("trips")
        .select(
          "id, purpose, title, work_stream_id, start_date, end_date, cities, status, billable_to, notes, work_streams(name)"
        )
        .order("start_date", { ascending: true, nullsFirst: false }),
      supabase.from("trip_expenses").select("trip_id, amount, billable"),
      supabase.from("bills").select("trip_id, status"),
      supabase
        .from("work_streams")
        .select("id, name")
        .eq("active", true)
        .order("name"),
    ]);

  // Roll the per-trip money up here: the list leads with what each trip is
  // worth in reimbursement, which is the number he actually scans for.
  const rows: TripRow[] = (trips ?? []).map((t) => {
    const mine = (expenses ?? []).filter((e) => e.trip_id === t.id);
    return {
      id: t.id,
      purpose: t.purpose,
      title: t.title,
      work_stream_id: t.work_stream_id,
      start_date: t.start_date,
      end_date: t.end_date,
      cities: Array.isArray(t.cities) ? (t.cities as string[]) : [],
      status: t.status,
      billable_to: t.billable_to,
      notes: t.notes,
      stream_name: (t.work_streams as { name: string } | null)?.name ?? "",
      billable_total: mine
        .filter((e) => e.billable)
        .reduce((sum, e) => sum + Number(e.amount), 0),
      expense_count: mine.length,
      bill_count: (bills ?? []).filter((b) => b.trip_id === t.id).length,
    };
  });

  return (
    <main>
      <TripsView
        trips={rows}
        workStreams={(streams ?? []) as WorkStreamRow[]}
        todayKey={civilKey(civilToday())}
      />
    </main>
  );
}
