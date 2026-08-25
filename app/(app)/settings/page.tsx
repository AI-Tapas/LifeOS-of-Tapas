import { createClient } from "@/lib/supabase/server";
import { PageHeader } from "@/components/ui";
import PasskeyButton from "@/components/passkey-button";
import SignOutButton from "@/components/sign-out-button";
import AccountsPanel, {
  type AccountView,
  type CalendarView,
} from "@/components/accounts-panel";
import PersonaPanel, {
  type PersonaVersionView,
} from "@/components/settings/persona-panel";
import ModelsPanel from "@/components/settings/models-panel";
import ConnectionsPanel, {
  type ConnectionView,
} from "@/components/settings/connections-panel";
import { providerOptions } from "@/lib/assistant/config";
import { slotByKey } from "@/lib/accounts";
import { formatDateIST } from "@/lib/datetime";

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

// How many credentials this client can still use. Reading the clock lives
// here rather than in the component body, which must stay pure.
function countLiveTokens(
  grants: { client_id: string; kind: string; expires_at: string }[],
  clientId: string
): number {
  const nowMs = Date.now();
  return grants.filter(
    (g) =>
      g.client_id === clientId &&
      g.kind !== "code" &&
      new Date(g.expires_at).getTime() > nowMs
  ).length;
}

export default async function SettingsPage({
  searchParams,
}: {
  searchParams: Promise<Search>;
}) {
  const sp = await searchParams;
  const status = statusMessage(sp);
  const supabase = await createClient();

  const [
    { data: accounts },
    { data: calendars },
    { data: streams, error },
    { data: personas },
    { data: modelSettings },
    { data: mcpClients },
    { data: mcpGrants },
  ] =
    await Promise.all([
      supabase
        .from("accounts")
        .select(
          "id, slot, provider, email, oauth_client, scopes, status, connect_mode, last_token_use"
        )
        .order("slot"),
      supabase
        .from("calendars")
        .select("id, account_id, name, is_primary_write, is_reminder_home, sync_enabled")
        .order("name"),
      supabase
        .from("work_streams")
        .select("id, name, kind, billing_entity, feeds_billing, active")
        .order("name"),
      supabase
        .from("assistant_persona")
        .select("id, version, source, active, created_at, sections_md")
        .order("version", { ascending: false }),
      supabase
        .from("assistant_settings")
        .select("chat_provider, chat_model, scan_provider, scan_model")
        .maybeSingle(),
      supabase
        .from("mcp_clients")
        .select("client_id, client_name, created_at, last_used_at")
        .order("created_at", { ascending: false }),
      supabase
        .from("mcp_grants")
        .select("client_id, kind, expires_at, revoked_at")
        .is("revoked_at", null),
    ]);

  const personaVersions: PersonaVersionView[] = (personas ?? []).map((p) => ({
    id: p.id,
    version: p.version,
    source: p.source,
    active: p.active,
    created_label: formatDateIST(p.created_at),
  }));
  const activePersonaMd = (personas ?? []).find((p) => p.active)?.sections_md ?? "";

  const connections: ConnectionView[] = (mcpClients ?? []).map((c) => ({
    client_id: c.client_id,
    client_name: c.client_name,
    created_label: formatDateIST(c.created_at),
    last_used_label: c.last_used_at ? formatDateIST(c.last_used_at) : null,
    active_tokens: countLiveTokens(mcpGrants ?? [], c.client_id),
  }));

  const toneClass =
    status?.tone === "ok"
      ? "border-green-300 bg-green-50 text-green-800 dark:border-green-800 dark:bg-green-950/40 dark:text-green-300"
      : status?.tone === "warn"
        ? "border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200"
        : "border-red-300 bg-red-50 text-red-700 dark:border-red-800 dark:bg-red-950/40 dark:text-red-300";

  return (
    <main>
      <PageHeader title="Settings" />

      {status && (
        <p className={"mt-4 rounded-xl border p-3 text-sm " + toneClass}>{status.text}</p>
      )}

      <h2 className="mt-6 text-base font-semibold tracking-tight">Accounts</h2>
      <p className="mt-1 text-sm text-neutral-500">
        External calendar and mail accounts. These are separate from your sign-in.
      </p>
      <div className="mt-3">
        <AccountsPanel
          accounts={(accounts ?? []) as AccountView[]}
          calendars={(calendars ?? []) as CalendarView[]}
        />
      </div>

      <h2 className="mt-8 text-base font-semibold tracking-tight">Work streams</h2>
      {error && (
        <p className="mt-2 text-sm text-red-600">
          Could not load work streams: {error.message}
        </p>
      )}
      <div className="mt-2 rounded-2xl border border-neutral-200 bg-white p-4 shadow-sm dark:border-neutral-800 dark:bg-neutral-900">
        <ul className="divide-y divide-neutral-200 dark:divide-neutral-800">
          {streams?.map((s) => (
            <li key={s.id} className="flex items-baseline justify-between py-3 first:pt-0 last:pb-0">
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
      </div>

      <h2 className="mt-8 text-base font-semibold tracking-tight">Assistant models</h2>
      <div className="mt-2">
        <ModelsPanel
          options={providerOptions()}
          envProvider={process.env.LLM_PROVIDER || "anthropic"}
          chat={{
            provider: modelSettings?.chat_provider ?? null,
            model: modelSettings?.chat_model ?? null,
          }}
          scan={{
            provider: modelSettings?.scan_provider ?? null,
            model: modelSettings?.scan_model ?? null,
          }}
        />
      </div>

      <h2 className="mt-8 text-base font-semibold tracking-tight">Connected applications</h2>
      <p className="mt-1 text-sm text-neutral-500">
        ChatGPT, Claude and other assistants you have allowed to use Life OS.
        They can read and act on your own lists; sending anything to another
        person still waits for your approval here.
      </p>
      <div className="mt-2">
        <ConnectionsPanel items={connections} />
      </div>

      <h2 className="mt-8 text-base font-semibold tracking-tight">Assistant persona</h2>
      <p className="mt-1 text-sm text-neutral-500">
        How the assistant sounds and judges. Kept private to your session.
      </p>
      <div className="mt-2">
        <PersonaPanel versions={personaVersions} activeMd={activePersonaMd} />
      </div>

      <h2 className="mt-8 text-base font-semibold tracking-tight">Security</h2>
      <div className="mt-2 rounded-2xl border border-neutral-200 bg-white p-4 shadow-sm dark:border-neutral-800 dark:bg-neutral-900">
        <div className="space-y-4">
          <PasskeyButton />
          <SignOutButton />
        </div>
      </div>
    </main>
  );
}
