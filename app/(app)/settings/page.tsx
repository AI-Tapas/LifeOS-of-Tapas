import { createClient } from "@/lib/supabase/server";
import PasskeyButton from "@/components/passkey-button";
import SignOutButton from "@/components/sign-out-button";

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const supabase = await createClient();
  const { data: streams, error } = await supabase
    .from("work_streams")
    .select("id, name, kind, billing_entity, feeds_billing, active")
    .order("name");

  return (
    <main>
      <h1 className="text-2xl font-semibold">Settings</h1>

      <h2 className="mt-6 text-lg font-medium">Work streams</h2>
      {error && (
        <p className="mt-2 text-sm text-red-600">
          Could not load work streams: {error.message}
        </p>
      )}
      <ul className="mt-2 divide-y divide-neutral-200 dark:divide-neutral-800">
        {streams?.map((s) => (
          <li key={s.id} className="flex items-baseline justify-between py-3">
            <div>
              <p className="font-medium">{s.name}</p>
              <p className="text-sm text-neutral-500">
                {s.kind.replace(/_/g, " ")}
                {s.billing_entity ? `, bills as ${s.billing_entity}` : ""}
              </p>
            </div>
            <span className="text-xs text-neutral-400">
              {s.feeds_billing ? "billable" : "non-billing"}
            </span>
          </li>
        ))}
      </ul>

      <h2 className="mt-10 text-lg font-medium">Security</h2>
      <div className="mt-2 space-y-4">
        <PasskeyButton />
        <SignOutButton />
      </div>
    </main>
  );
}
