import { createClient } from "@/lib/supabase/server";
import MonthPack from "@/components/trips/month-pack";
import {
  previousMonthKey,
  type MonthExpense,
  type MonthTrip,
} from "@/lib/trips/month";
import { civilKey, civilToday } from "@/lib/datetime";

export const dynamic = "force-dynamic";

// The handover screen for his monthly invoice run. It loads every trip and
// expense once and lets the client switch months in memory: the whole travel
// history is a few hundred rows for a single user, so a query per month would
// buy nothing.
export default async function TripMonthPage() {
  const supabase = await createClient();
  const [{ data: trips }, { data: expenses }] = await Promise.all([
    supabase
      .from("trips")
      .select("id, title, start_date, end_date, cities, bills_to, legs")
      .order("start_date", { ascending: true, nullsFirst: false }),
    supabase
      .from("trip_expenses")
      .select("id, trip_id, category, amount, date, billable, receipt_ref")
      .order("date"),
  ]);

  const todayKey = civilKey(civilToday());

  return (
    <main>
      <MonthPack
        trips={(trips ?? []).map(
          (t): MonthTrip => ({
            id: t.id,
            title: t.title,
            start_date: t.start_date,
            end_date: t.end_date,
            cities: Array.isArray(t.cities) ? (t.cities as string[]) : [],
            bills_to: t.bills_to,
            legs: t.legs,
          })
        )}
        expenses={(expenses ?? []).map(
          (e): MonthExpense => ({
            id: e.id,
            trip_id: e.trip_id,
            category: e.category,
            amount: Number(e.amount),
            date: e.date,
            billable: e.billable,
            receipt_ref: e.receipt_ref,
          })
        )}
        defaultMonth={previousMonthKey(todayKey)}
        maxMonth={todayKey.slice(0, 7)}
      />
    </main>
  );
}
