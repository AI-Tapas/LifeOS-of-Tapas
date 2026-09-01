import { createClient } from "@/lib/supabase/server";
import { PageHeader } from "@/components/ui";
import ObligationsPanel, {
  type ObligationRow,
} from "@/components/money/obligations-panel";
import InvestmentsPanel, {
  type HoldingRow,
} from "@/components/money/investments-panel";
import { civilKey, civilToday } from "@/lib/datetime";

export const dynamic = "force-dynamic";

export default async function MoneyPage() {
  const supabase = await createClient();
  const [{ data: obligations }, { data: holdings }] = await Promise.all([
    supabase
      .from("recurring_obligations")
      .select(
        "id, name, category, amount, variable_amount, frequency, due_day, due_month, interval_rule, anchor_date, autopay, account_ref, active, notes, remind_offsets"
      )
      .order("name"),
    supabase
      .from("finance_items")
      .select("id, kind, name, institution, value, key_date, key_date_type, remind, notes")
      // Dated holdings first and soonest first, so what needs an answer is at
      // the top; the undated ones fall to the bottom rather than the middle.
      .order("key_date", { ascending: true, nullsFirst: false })
      .order("name"),
  ]);

  const todayKey = civilKey(civilToday());

  return (
    <main>
      <PageHeader title="Money" subtitle="Investments and recurring obligations" />
      <div className="mt-4">
        <InvestmentsPanel
          holdings={(holdings ?? []) as HoldingRow[]}
          todayKey={todayKey}
        />
      </div>
      <div className="mt-8">
        <ObligationsPanel
          obligations={(obligations ?? []) as ObligationRow[]}
          todayKey={todayKey}
        />
      </div>
    </main>
  );
}
