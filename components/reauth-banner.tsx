import { createClient } from "@/lib/supabase/server";
import { slotByKey } from "@/lib/accounts";

// App-shell banner: shows when any connected account has been revoked and needs
// a one-tap reconnect. Rendered in the (app) layout, so it appears everywhere
// including Settings.
export default async function ReauthBanner() {
  const supabase = await createClient();
  const { data } = await supabase
    .from("accounts")
    .select("id, slot")
    .eq("status", "needs_reauth");

  if (!data || data.length === 0) return null;

  return (
    <div className="mb-4 rounded-xl border border-today/30 bg-today-soft p-3 text-sm">
      <p className="font-medium text-today">
        {data.length === 1 ? "An account needs" : "Some accounts need"} reconnecting
      </p>
      <div className="mt-2 flex flex-wrap gap-2">
        {data.map((a) => {
          const slot = slotByKey(a.slot);
          if (!slot) return null;
          return (
            <a
              key={a.id}
              href={`/api/oauth/${slot.provider}/start?slot=${slot.key}`}
              className="rounded-lg bg-today px-3 py-1.5 font-medium text-white dark:text-neutral-950"
            >
              Reconnect {slot.label}
            </a>
          );
        })}
      </div>
    </div>
  );
}
