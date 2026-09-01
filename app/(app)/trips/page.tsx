import { createClient } from "@/lib/supabase/server";
import TripsView, {
  type TripRow,
  type WorkStreamRow,
} from "@/components/trips/trips-view";
import {
  currentAndPreviousMonths,
  receiptGaps,
  type MonthExpense,
} from "@/lib/trips/month";
import { civilKey, civilToday } from "@/lib/datetime";

export const dynamic = "force-dynamic";

export default async function TripsPage() {
  const supabase = await createClient();
  const [{ data: trips }, { data: expenses }, { data: steps }, { data: streams }] =
    await Promise.all([
      supabase
        .from("trips")
        .select(
          "id, purpose, title, work_stream_id, start_date, end_date, cities, status, bills_to, notes, work_streams(name)"
        )
        .order("start_date", { ascending: true, nullsFirst: false }),
      supabase
        .from("trip_expenses")
        .select("id, trip_id, category, amount, date, billable, receipt_ref"),
      // Checklist steps, so each trip line can say how far through it is.
      supabase.from("tasks").select("trip_id, status").not("trip_id", "is", null),
      supabase
        .from("work_streams")
        .select("id, name")
        .eq("active", true)
        .order("name"),
    ]);

  const todayKey = civilKey(civilToday());
  const allExpenses: MonthExpense[] = (expenses ?? []).map((e) => ({
    id: e.id,
    trip_id: e.trip_id,
    category: e.category,
    amount: Number(e.amount),
    date: e.date,
    billable: e.billable,
    receipt_ref: e.receipt_ref,
  }));

  // Roll the per-trip money up here: the list leads with the city, then what
  // the trip carries for the monthly claim.
  const rows: TripRow[] = (trips ?? []).map((t) => {
    const mine = allExpenses.filter((e) => e.trip_id === t.id);
    // Dropped steps leave the denominator: he decided one was not owed, so
    // counting it would leave the trip looking permanently unfinished.
    const mySteps = (steps ?? []).filter(
      (x) => x.trip_id === t.id && x.status !== "dropped"
    );
    return {
      id: t.id,
      purpose: t.purpose,
      title: t.title,
      work_stream_id: t.work_stream_id,
      start_date: t.start_date,
      end_date: t.end_date,
      cities: Array.isArray(t.cities) ? (t.cities as string[]) : [],
      status: t.status,
      bills_to: t.bills_to,
      notes: t.notes,
      stream_name: (t.work_streams as { name: string } | null)?.name ?? "",
      billable_total: mine
        .filter((e) => e.billable)
        .reduce((sum, e) => sum + e.amount, 0),
      expense_count: mine.length,
      checklist_done: mySteps.filter((x) => x.status === "done").length,
      checklist_total: mySteps.length,
      receipts_missing: mine.filter(
        (e) => e.billable && !(e.receipt_ref ?? "").trim()
      ).length,
    };
  });

  // The standing line: gaps in the month running and the one just gone, which
  // are the two he can still fix cheaply.
  const gapMonths = currentAndPreviousMonths(todayKey);

  return (
    <main>
      <TripsView
        trips={rows}
        workStreams={(streams ?? []) as WorkStreamRow[]}
        todayKey={todayKey}
        receiptGapCount={receiptGaps(allExpenses, gapMonths).length}
        receiptGapMonths={gapMonths}
      />
    </main>
  );
}
