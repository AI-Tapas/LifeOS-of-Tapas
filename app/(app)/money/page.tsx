import { createClient } from "@/lib/supabase/server";
import { PageHeader } from "@/components/ui";
import ObligationsPanel, {
  type ObligationRow,
} from "@/components/money/obligations-panel";

export const dynamic = "force-dynamic";

export default async function MoneyPage() {
  const supabase = await createClient();
  const { data: obligations } = await supabase
    .from("recurring_obligations")
    .select(
      "id, name, category, amount, variable_amount, frequency, due_day, due_month, autopay, account_ref, active, notes, remind_offsets"
    )
    .order("name");

  return (
    <main>
      <PageHeader title="Money" subtitle="Recurring obligations" />
      <div className="mt-4">
        <ObligationsPanel obligations={(obligations ?? []) as ObligationRow[]} />
      </div>
    </main>
  );
}
