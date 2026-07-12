"use client";

import { useState, useTransition } from "react";
import { SLOTS } from "@/lib/accounts";
import {
  refreshCalendarsAction,
  disconnectAction,
  setForwardedAction,
  setPrimaryWriteAction,
  setReminderHomeAction,
  setCalendarSyncAction,
} from "@/app/(app)/settings/actions";

export interface AccountView {
  id: string;
  slot: string | null;
  provider: "google" | "microsoft";
  email: string;
  scopes: string[];
  status: "connected" | "needs_reauth" | "forwarded" | "disconnected";
  connect_mode: "direct" | "forwarded";
  last_token_use: string | null;
}

export interface CalendarView {
  id: string;
  account_id: string;
  name: string;
  is_primary_write: boolean;
  is_reminder_home: boolean;
  sync_enabled: boolean;
}

const STATUS_STYLE: Record<AccountView["status"], string> = {
  connected: "bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-300",
  needs_reauth: "bg-amber-100 text-amber-900 dark:bg-amber-900/40 dark:text-amber-200",
  forwarded: "bg-sky-100 text-sky-800 dark:bg-sky-900/40 dark:text-sky-300",
  disconnected: "bg-neutral-100 text-neutral-600 dark:bg-neutral-800 dark:text-neutral-400",
};

const STATUS_LABEL: Record<AccountView["status"], string> = {
  connected: "Connected",
  needs_reauth: "Needs reconnect",
  forwarded: "Forwarded",
  disconnected: "Disconnected",
};

function fmtIST(iso: string | null): string {
  if (!iso) return "never";
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Kolkata",
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(iso));
}

function scopeShort(scope: string): string {
  return scope
    .replace("https://www.googleapis.com/auth/", "")
    .replace("openid", "openid");
}

export default function AccountsPanel({
  accounts,
  calendars,
}: {
  accounts: AccountView[];
  calendars: CalendarView[];
}) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<
    { id: string; tone: "ok" | "warn" | "err"; text: string } | null
  >(null);

  const bySlot = new Map(accounts.filter((a) => a.slot).map((a) => [a.slot!, a]));
  const calsByAccount = new Map<string, CalendarView[]>();
  for (const c of calendars) {
    const list = calsByAccount.get(c.account_id) ?? [];
    list.push(c);
    calsByAccount.set(c.account_id, list);
  }

  function run(fn: () => Promise<void>) {
    setError(null);
    startTransition(async () => {
      try {
        await fn();
      } catch (e) {
        setError(e instanceof Error ? e.message : "Something went wrong.");
      }
    });
  }

  // Refresh calendars reports its own per-card result: a synced count, a
  // needs_reauth prompt, or a readable error. It never throws to the render.
  function runRefresh(accountId: string) {
    setError(null);
    setNotice(null);
    startTransition(async () => {
      try {
        const r = await refreshCalendarsAction(accountId);
        if (r.ok) {
          setNotice({
            id: accountId,
            tone: "ok",
            text: `${r.count} calendar${r.count === 1 ? "" : "s"} synced.`,
          });
        } else if ("reason" in r) {
          setNotice({
            id: accountId,
            tone: "warn",
            text: "Access was revoked. Use Reconnect to restore service.",
          });
        } else {
          setNotice({ id: accountId, tone: "err", text: r.message });
        }
      } catch (e) {
        setNotice({
          id: accountId,
          tone: "err",
          text: e instanceof Error ? e.message : "Could not refresh calendars.",
        });
      }
    });
  }

  const caAccount = bySlot.get("ca_tapasnr");
  const reminderCals = caAccount ? calsByAccount.get(caAccount.id) ?? [] : [];
  const currentReminderHome = reminderCals.find((c) => c.is_reminder_home);

  return (
    <div className="space-y-4">
      {error && <p className="text-sm text-red-600">{error}</p>}

      {SLOTS.map((slot) => {
        const acct = bySlot.get(slot.key);
        const status: AccountView["status"] = acct?.status ?? "disconnected";
        const cals = acct ? calsByAccount.get(acct.id) ?? [] : [];
        const writeCal = cals.find((c) => c.is_primary_write);
        const connected = status === "connected" || status === "needs_reauth";
        const startHref = `/api/oauth/${slot.provider}/start?slot=${slot.key}`;

        return (
          <section
            key={slot.key}
            className="rounded-xl border border-neutral-200 p-4 dark:border-neutral-800"
          >
            <div className="flex items-start justify-between gap-3">
              <div>
                <h3 className="font-medium">{slot.label}</h3>
                {acct && connected ? (
                  <p className="text-sm text-neutral-500">{acct.email}</p>
                ) : (
                  <p className="text-sm text-neutral-500">{slot.note}</p>
                )}
              </div>
              <span
                className={"shrink-0 rounded-full px-2 py-0.5 text-xs " + STATUS_STYLE[status]}
              >
                {STATUS_LABEL[status]}
              </span>
            </div>

            {status === "needs_reauth" && (
              <p className="mt-2 text-sm text-amber-700 dark:text-amber-300">
                Access was revoked (this happens after a password change). Reconnect to
                restore service.
              </p>
            )}

            {connected && (
              <div className="mt-3 space-y-3">
                <p className="text-xs text-neutral-500">
                  Scopes: {acct!.scopes.map(scopeShort).join(", ") || "none"}
                </p>
                <p className="text-xs text-neutral-500">
                  Last token use: {fmtIST(acct!.last_token_use)} IST
                </p>

                {cals.length > 0 && (
                  <label className="block space-y-1">
                    <span className="text-sm font-medium">Write-back calendar</span>
                    <select
                      value={writeCal?.id ?? ""}
                      disabled={pending}
                      onChange={(e) =>
                        run(() => setPrimaryWriteAction(acct!.id, e.target.value))
                      }
                      className="w-full rounded-lg border border-neutral-300 px-3 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-900"
                    >
                      <option value="" disabled>
                        Choose a calendar
                      </option>
                      {cals.map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.name}
                        </option>
                      ))}
                    </select>
                  </label>
                )}

                {cals.length > 0 && (
                  <div className="space-y-1">
                    <span className="text-sm font-medium">Sync these calendars</span>
                    {cals.map((c) => (
                      <label key={c.id} className="flex items-center gap-2 text-sm">
                        <input
                          type="checkbox"
                          checked={c.sync_enabled}
                          disabled={pending}
                          onChange={(e) =>
                            run(() => setCalendarSyncAction(c.id, e.target.checked))
                          }
                        />
                        <span>{c.name}</span>
                      </label>
                    ))}
                  </div>
                )}

                <div className="flex flex-wrap gap-2">
                  {status === "connected" && (
                    <button
                      onClick={() => runRefresh(acct!.id)}
                      disabled={pending}
                      className="rounded-lg border border-neutral-300 px-3 py-1.5 text-sm disabled:opacity-50 dark:border-neutral-700"
                    >
                      {pending ? "Refreshing" : `Refresh calendars (${cals.length})`}
                    </button>
                  )}
                  {status === "needs_reauth" && (
                    <a
                      href={startHref}
                      className="rounded-lg bg-amber-600 px-3 py-1.5 text-sm font-medium text-white"
                    >
                      Reconnect
                    </a>
                  )}
                  <button
                    onClick={() => {
                      if (confirm(`Disconnect ${slot.label}?`)) {
                        run(() => disconnectAction(acct!.id));
                      }
                    }}
                    disabled={pending}
                    className="rounded-lg border border-neutral-300 px-3 py-1.5 text-sm text-red-600 disabled:opacity-50 dark:border-neutral-700"
                  >
                    Disconnect
                  </button>
                </div>

                {notice && notice.id === acct!.id && (
                  <p
                    className={
                      "text-sm " +
                      (notice.tone === "ok"
                        ? "text-green-600"
                        : notice.tone === "warn"
                          ? "text-amber-700 dark:text-amber-300"
                          : "text-red-600")
                    }
                  >
                    {notice.text}
                  </p>
                )}
              </div>
            )}

            {!connected && status !== "forwarded" && (
              <div className="mt-3">
                <a
                  href={startHref}
                  className="inline-block rounded-lg bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white"
                >
                  Connect
                </a>
              </div>
            )}

            {status === "forwarded" && (
              <p className="mt-3 text-sm text-neutral-500">
                Mail arrives via a Gmail forwarding filter into ca.tapasnr. No direct
                connection is held.
              </p>
            )}

            {slot.allowForwarded && (
              <label className="mt-3 flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={status === "forwarded"}
                  disabled={pending}
                  onChange={(e) => run(() => setForwardedAction(e.target.checked))}
                />
                <span>Treat as forwarded (admin blocked the direct connection)</span>
              </label>
            )}
          </section>
        );
      })}

      {caAccount && reminderCals.length > 0 && (
        <section className="rounded-xl border border-neutral-200 p-4 dark:border-neutral-800">
          <h3 className="font-medium">Reminder-home calendar</h3>
          <p className="text-sm text-neutral-500">
            Where app reminders are written. Must be a ca.tapasnr calendar.
          </p>
          <select
            value={currentReminderHome?.id ?? ""}
            disabled={pending}
            onChange={(e) => run(() => setReminderHomeAction(e.target.value))}
            className="mt-2 w-full rounded-lg border border-neutral-300 px-3 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-900"
          >
            <option value="" disabled>
              Choose a calendar
            </option>
            {reminderCals.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </section>
      )}
    </div>
  );
}
