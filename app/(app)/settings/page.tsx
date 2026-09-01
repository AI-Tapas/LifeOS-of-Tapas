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
import ThemePanel from "@/components/settings/theme-panel";
import ReminderCleanupPanel from "@/components/settings/reminder-cleanup-panel";
import ConnectionsPanel, {
  type ConnectionView,
} from "@/components/settings/connections-panel";
import { providerOptions } from "@/lib/assistant/config";
import { slotByKey } from "@/lib/accounts";
import { formatDateIST } from "@/lib/datetime";
import { describeError, recordEvent } from "@/lib/errors";

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

  // Shaping the rows for display is where a render throws if any value is not
  // what its type promises, and in production that becomes a bare digest with
  // no message. Naming the step that failed, and recording it, beats a number.
  let personaVersions: PersonaVersionView[] = [];
  let activePersonaMd = "";
  let connections: ConnectionView[] = [];
  let renderFault: string | null = null;
  try {
    personaVersions = (personas ?? []).map((p) => ({
      id: p.id,
      version: p.version,
      source: p.source,
      active: p.active,
      created_label: formatDateIST(p.created_at),
    }));
    activePersonaMd = (personas ?? []).find((p) => p.active)?.sections_md ?? "";
    connections = (mcpClients ?? []).map((c) => ({
      client_id: c.client_id,
      client_name: c.client_name,
      created_label: formatDateIST(c.created_at),
      last_used_label: c.last_used_at ? formatDateIST(c.last_used_at) : null,
      active_tokens: countLiveTokens(mcpGrants ?? [], c.client_id),
    }));
  } catch (e) {
    renderFault = describeError(e);
    await recordEvent("settings_render_failed", renderFault);
  }

  const toneClass =
    status?.tone === "ok"
      ? "border-ok/30 bg-ok-soft text-ok"
      : status?.tone === "warn"
        ? "border-today/30 bg-today-soft text-today"
        : "border-overdue/30 bg-overdue-soft text-overdue";

  return (
    <main>
      <PageHeader title="Settings" />

      {status && (
        <p className={"mt-4 rounded-xl border p-3 text-sm " + toneClass}>{status.text}</p>
      )}

      {renderFault && (
        <p className="mt-4 rounded-xl border border-overdue/30 bg-overdue-soft p-3 text-sm text-overdue">
          Part of this page could not be prepared: {renderFault}
        </p>
      )}

      <h2 className="mt-6 text-base font-semibold tracking-tight">Appearance</h2>
      <p className="mt-1 text-sm text-secondary">
        The app followed your device until now, which is why it turned dark on
        the iPad.
      </p>
      <div className="mt-3">
        <ThemePanel />
      </div>

      <h2 className="mt-8 text-base font-semibold tracking-tight">Accounts</h2>
      <p className="mt-1 text-sm text-secondary">
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
        <p className="mt-2 text-sm text-overdue">
          Could not load work streams: {error.message}
        </p>
      )}
      <div className="mt-2 rounded-2xl border border-border bg-surface p-4 shadow-[var(--shadow-card)]">
        <ul className="divide-y divide-border">
          {streams?.map((s) => (
            <li key={s.id} className="flex items-baseline justify-between py-3 first:pt-0 last:pb-0">
              <div>
                <p className="font-medium">{s.name}</p>
                <p className="text-sm text-secondary">
                  {s.kind.replace(/_/g, " ")}
                  {s.billing_entity ? `, bills as ${s.billing_entity}` : ""}
                </p>
              </div>
              <span className="text-xs text-muted">
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
      <p className="mt-1 text-sm text-secondary">
        ChatGPT, Claude and other assistants you have allowed to use Life OS.
        They can read and act on your own lists; sending anything to another
        person still waits for your approval here.
      </p>
      <div className="mt-2">
        <ConnectionsPanel items={connections} />
      </div>

      <h2 className="mt-8 text-base font-semibold tracking-tight">Calendar reminders</h2>
      <p className="mt-1 text-sm text-secondary">
        The calendar is for the dates that must interrupt you. Routine work
        stays in the app and on your morning brief.
      </p>
      <div className="mt-2">
        <ReminderCleanupPanel />
      </div>

      <h2 className="mt-8 text-base font-semibold tracking-tight">Assistant persona</h2>
      <p className="mt-1 text-sm text-secondary">
        How the assistant sounds and judges. Kept private to your session.
      </p>
      <div className="mt-2">
        <PersonaPanel versions={personaVersions} activeMd={activePersonaMd} />
      </div>

      <h2 className="mt-8 text-base font-semibold tracking-tight">Security</h2>
      <div className="mt-2 rounded-2xl border border-border bg-surface p-4 shadow-[var(--shadow-card)]">
        <div className="space-y-4">
          <PasskeyButton />
          <SignOutButton />
        </div>
      </div>
    </main>
  );
}
