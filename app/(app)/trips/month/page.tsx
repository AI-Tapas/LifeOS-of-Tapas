import { createClient } from "@/lib/supabase/server";
import MonthPack from "@/components/trips/month-pack";
import { previousMonthKey, toMonthExpense, toMonthTrip } from "@/lib/trips/month";
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
      .select("id, title, start_date, end_date, cities, bills_to, legs, work_streams(name)")
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
        // Mapped by the same functions lifeos_get_month_pack uses (B22).
        trips={(trips ?? []).map((t) =>
          toMonthTrip({
            ...t,
            stream_name: (t.work_streams as { name: string } | null)?.name ?? null,
          })
        )}
        expenses={(expenses ?? []).map(toMonthExpense)}
        defaultMonth={previousMonthKey(todayKey)}
        maxMonth={todayKey.slice(0, 7)}
      />
    </main>
  );
}
