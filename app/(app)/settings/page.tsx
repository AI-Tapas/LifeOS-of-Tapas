import { createClient } from "@/lib/supabase/server";
import PasskeyButton from "@/components/passkey-button";
import SignOutButton from "@/components/sign-out-button";
import AccountsPanel, {
  type AccountView,
  type CalendarView,
} from "@/components/accounts-panel";
import { slotByKey } from "@/lib/accounts";

export const dynamic = "force-dynamic";

type Search = Record<string, string | string[] | undefined>;

function one(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

// Turn the OAuth callback / action redirect query into a single status line.
function statusMessage(sp: Search): { tone: "ok" | "warn" | "err"; text: string } | null {
  const connected = one(sp.connected);
  if (connected) {
    const label = slotByKey(connected)?.label ?? connected;
    if (one(sp.cal_warn)) {
      return {
        tone: "warn",
        text: `Connected ${label}, but the calendar list could not be fetched. Try Refresh calendars.`,
      };
    }
    return { tone: "ok", text: `Connected ${label}.` };
  }
  if (one(sp.blocked)) {
    return {
      tone: "warn",
      text: "The org blocked the direct connection. You can mark it forwarded below.",
    };
  }
  const error = one(sp.error);
  if (error) {
    const detail = one(sp.detail);
    const map: Record<string, string> = {
      wrong_account: detail ?? "That account is not allowed for this slot.",
      bad_slot: "Unknown account slot.",
      bad_state: "The sign-in state did not match. Please try again.",
      exchange_failed: "Could not complete the connection. Please try again.",
      no_email: "The provider did not return an email address.",
      no_flow: "The connection attempt expired. Please start again.",
      not_signed_in: "Please sign in and retry.",
      save_failed: detail ? `Could not save the account: ${detail}` : "Could not save the account.",
    };
    return { tone: "err", text: map[error] ?? `Connection failed: ${error}` };
  }
  return null;
}

export default async function SettingsPage({
  searchParams,
}: {
  searchParams: Promise<Search>;
}) {
  const sp = await searchParams;
  const status = statusMessage(sp);
  const supabase = await createClient();

  const [{ data: accounts }, { data: calendars }, { data: streams, error }] =
    await Promise.all([
      supabase
        .from("accounts")
        .select(
          "id, slot, provider, email, oauth_client, scopes, status, connect_mode, last_token_use"
        )
        .order("slot"),
      supabase
        .from("calendars")
        .select("id, account_id, name, is_primary_write, is_reminder_home")
        .order("name"),
      supabase
        .from("work_streams")
        .select("id, name, kind, billing_entity, feeds_billing, active")
        .order("name"),
    ]);

  const toneClass =
    status?.tone === "ok"
      ? "border-green-300 bg-green-50 text-green-800 dark:border-green-800 dark:bg-green-950/40 dark:text-green-300"
      : status?.tone === "warn"
        ? "border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200"
        : "border-red-300 bg-red-50 text-red-700 dark:border-red-800 dark:bg-red-950/40 dark:text-red-300";

  return (
    <main>
      <h1 className="text-2xl font-semibold">Settings</h1>

      {status && (
        <p className={"mt-4 rounded-xl border p-3 text-sm " + toneClass}>{status.text}</p>
      )}

      <h2 className="mt-6 text-lg font-medium">Accounts</h2>
      <p className="mt-1 text-sm text-neutral-500">
        External calendar and mail accounts. These are separate from your sign-in.
      </p>
      <div className="mt-3">
        <AccountsPanel
          accounts={(accounts ?? []) as AccountView[]}
          calendars={(calendars ?? []) as CalendarView[]}
        />
      </div>

      <h2 className="mt-10 text-lg font-medium">Work streams</h2>
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
