import { createClient } from "@/lib/supabase/server";
import { PageHeader } from "@/components/ui";
import UnbilledView from "@/components/billing/unbilled-view";
import { loadUnbilled } from "@/lib/billing/load";

export const dynamic = "force-dynamic";

export default async function UnbilledPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  const groups = user ? await loadUnbilled(supabase, user.id) : [];
  // The agents' own instruction text is not for this screen.
  const shown = groups.map((g) => ({
    stream: g.stream,
    rows: g.rows.map((r) => ({ ...r, instructions_for_agents: null })),
  }));
  return (
    <main>
      <PageHeader
        title="Unbilled"
        subtitle="Finished client work with no invoice against it, last 180 days"
      />
      <UnbilledView groups={shown} />
    </main>
  );
}
