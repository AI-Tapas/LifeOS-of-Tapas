// Event sync (read path). Pulls events from every sync-enabled calendar across
// all connected accounts into the events table. Incremental where the provider
// supports it (Google syncToken, Microsoft Graph delta) with a full-window
// fallback when the cursor is invalidated. On-demand only: the calendar page
// calls this on open when stale, plus a manual refresh. No background daemon
// (that is M5). Every provider call goes through withResourceAuth, so a
// provider-side 401 is refreshed once and a revoked grant flips the account to
// needs_reauth (handled here as a graceful skip, never a raw 500).

import { withResourceAuth } from "@/lib/oauth/tokens";
import { createServiceClient } from "@/lib/supabase/service";
import { TokenRevokedError } from "@/lib/oauth/core";
import { parseGoogleEvent, parseGraphEvent, type ParsedEvent } from "@/lib/events/payload";
import { retryPendingReminders } from "@/lib/reminders/writer";
import type { Provider } from "@/lib/accounts";
import type { Database, Json } from "@/lib/database.types";
import type { SupabaseClient } from "@supabase/supabase-js";

type Svc = SupabaseClient<Database>;

// Rolling window: 60 days back, 12 months forward. Documented in the README.
const WINDOW_BACK_DAYS = 60;
const WINDOW_FORWARD_DAYS = 365;
// The calendar page treats data older than this as stale and triggers a sync.
export const SYNC_STALE_MINUTES = 15;

function windowRange(now = Date.now()): { timeMin: string; timeMax: string } {
  return {
    timeMin: new Date(now - WINDOW_BACK_DAYS * 86400000).toISOString(),
    timeMax: new Date(now + WINDOW_FORWARD_DAYS * 86400000).toISOString(),
  };
}

export function isStale(
  lastSyncedAt: string | null | undefined,
  maxMinutes = SYNC_STALE_MINUTES,
  now = Date.now()
): boolean {
  if (!lastSyncedAt) return true;
  return now - new Date(lastSyncedAt).getTime() > maxMinutes * 60000;
}

interface AccountRow {
  id: string;
  slot: string | null;
  provider: Provider;
  status: Database["public"]["Enums"]["account_status"];
}

interface CalendarRow {
  id: string;
  account_id: string;
  ext_calendar_id: string;
  sync_token: string | null;
}

export interface AccountSyncResult {
  slot: string | null;
  status: string;
  upserted: number;
  deleted: number;
  skipped?: string; // reason the account was not synced
  error?: string;
}

// ---------------------------------------------------------------------------
// Google
// ---------------------------------------------------------------------------
interface GooglePage {
  items: unknown[];
  nextSyncToken: string | null;
  gone: boolean; // 410: the syncToken expired, caller must full-resync
}

async function fetchGooglePages(
  accountId: string,
  calExtId: string,
  opts: { syncToken?: string | null; timeMin?: string; timeMax?: string }
): Promise<GooglePage> {
  const base = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(
    calExtId
  )}/events`;
  const items: unknown[] = [];
  let nextSyncToken: string | null = null;
  let pageToken: string | null = null;
  let first = true;

  for (let guard = 0; guard < 50; guard++) {
    const p = new URLSearchParams({ singleEvents: "true", maxResults: "250" });
    if (pageToken) {
      p.set("pageToken", pageToken);
    } else if (first && opts.syncToken) {
      p.set("syncToken", opts.syncToken);
      p.set("showDeleted", "true");
    } else if (first) {
      if (opts.timeMin) p.set("timeMin", opts.timeMin);
      if (opts.timeMax) p.set("timeMax", opts.timeMax);
    }
    first = false;

    const res = await withResourceAuth(accountId, (token) =>
      fetch(`${base}?${p.toString()}`, {
        headers: { authorization: `Bearer ${token}` },
      })
    );
    if (res.status === 410) return { items, nextSyncToken: null, gone: true };
    if (!res.ok) throw new Error(`google events ${res.status}`);

    const j = (await res.json()) as {
      items?: unknown[];
      nextPageToken?: string;
      nextSyncToken?: string;
    };
    if (j.items) items.push(...j.items);
    if (j.nextSyncToken) nextSyncToken = j.nextSyncToken;
    if (!j.nextPageToken) break;
    pageToken = j.nextPageToken;
  }
  return { items, nextSyncToken, gone: false };
}

// ---------------------------------------------------------------------------
// Microsoft Graph (calendarView delta)
// ---------------------------------------------------------------------------
interface GraphPage {
  items: unknown[];
  deltaLink: string | null;
  gone: boolean;
}

async function fetchGraphPages(
  accountId: string,
  calExtId: string,
  opts: { deltaLink?: string | null; timeMin?: string; timeMax?: string }
): Promise<GraphPage> {
  let url: string;
  if (opts.deltaLink) {
    url = opts.deltaLink;
  } else {
    const p = new URLSearchParams({
      startDateTime: opts.timeMin ?? "",
      endDateTime: opts.timeMax ?? "",
    });
    url = `https://graph.microsoft.com/v1.0/me/calendars/${encodeURIComponent(
      calExtId
    )}/calendarView/delta?${p.toString()}`;
  }

  const items: unknown[] = [];
  let deltaLink: string | null = null;

  for (let guard = 0; guard < 100; guard++) {
    const res = await withResourceAuth(accountId, (token) =>
      fetch(url, {
        headers: {
          authorization: `Bearer ${token}`,
          Prefer: 'outlook.timezone="UTC"',
        },
      })
    );
    if (res.status === 410) return { items, deltaLink: null, gone: true };
    if (!res.ok) throw new Error(`graph delta ${res.status}`);

    const j = (await res.json()) as {
      value?: unknown[];
      "@odata.nextLink"?: string;
      "@odata.deltaLink"?: string;
    };
    if (j.value) items.push(...j.value);
    if (j["@odata.deltaLink"]) deltaLink = j["@odata.deltaLink"];
    const next = j["@odata.nextLink"];
    if (!next) break;
    url = next;
  }
  return { items, deltaLink, gone: false };
}

// ---------------------------------------------------------------------------
// Apply parsed events to the events table
// ---------------------------------------------------------------------------
async function applyEvents(
  svc: Svc,
  ctx: { userId: string; accountId: string; calendarId: string },
  parsed: ParsedEvent[],
  fullResync: boolean
): Promise<{ upserted: number; deleted: number }> {
  const upserts = parsed.filter((p): p is Extract<ParsedEvent, { kind: "upsert" }> => p.kind === "upsert");
  const deletes = parsed.filter((p) => p.kind === "delete").map((p) => p.ext_event_id);

  // Preserve the source of app-created and reminder events: a re-sync must not
  // downgrade them to 'synced'. Look up existing sources for this batch.
  const ids = upserts.map((u) => u.ext_event_id);
  const sourceByExt = new Map<string, string>();
  for (let i = 0; i < ids.length; i += 300) {
    const chunk = ids.slice(i, i + 300);
    const { data } = await svc
      .from("events")
      .select("ext_event_id, source")
      .eq("calendar_id", ctx.calendarId)
      .in("ext_event_id", chunk);
    for (const row of data ?? []) {
      if (row.ext_event_id && (row.source === "app" || row.source === "reminder")) {
        sourceByExt.set(row.ext_event_id, row.source);
      }
    }
  }

  const rows = upserts.map((u) => ({
    user_id: ctx.userId,
    account_id: ctx.accountId,
    calendar_id: ctx.calendarId,
    ext_event_id: u.ext_event_id,
    title: u.title,
    description: u.description,
    location: u.location,
    start_ts: u.start_ts,
    end_ts: u.end_ts,
    all_day: u.all_day,
    attendees: (u.attendees ?? null) as Json,
    source:
      (sourceByExt.get(u.ext_event_id) as Database["public"]["Enums"]["event_source"]) ??
      ("synced" as const),
    updated_at: new Date().toISOString(),
  }));

  let upserted = 0;
  for (let i = 0; i < rows.length; i += 500) {
    const chunk = rows.slice(i, i + 500);
    const { error } = await svc
      .from("events")
      .upsert(chunk, { onConflict: "calendar_id,ext_event_id" });
    if (error) throw error;
    upserted += chunk.length;
  }

  let deleted = 0;
  if (deletes.length) {
    for (let i = 0; i < deletes.length; i += 300) {
      const chunk = deletes.slice(i, i + 300);
      const { error } = await svc
        .from("events")
        .delete()
        .eq("calendar_id", ctx.calendarId)
        .in("ext_event_id", chunk);
      if (error) throw error;
      deleted += chunk.length;
    }
  }

  // A full resync returns no deletions, so reconcile: remove synced events in
  // this calendar that the provider no longer returned. Never touch app or
  // reminder rows.
  if (fullResync) {
    const seen = new Set(ids);
    const { data: existing } = await svc
      .from("events")
      .select("ext_event_id")
      .eq("calendar_id", ctx.calendarId)
      .eq("source", "synced");
    const stale = (existing ?? [])
      .map((r) => r.ext_event_id)
      .filter((e): e is string => !!e && !seen.has(e));
    for (let i = 0; i < stale.length; i += 300) {
      const chunk = stale.slice(i, i + 300);
      const { error } = await svc
        .from("events")
        .delete()
        .eq("calendar_id", ctx.calendarId)
        .eq("source", "synced")
        .in("ext_event_id", chunk);
      if (error) throw error;
      deleted += chunk.length;
    }
  }

  return { upserted, deleted };
}

async function syncOneCalendar(
  svc: Svc,
  account: AccountRow,
  cal: CalendarRow,
  userId: string
): Promise<{ upserted: number; deleted: number }> {
  const { timeMin, timeMax } = windowRange();
  let parsed: ParsedEvent[] = [];
  let newCursor: string | null = null;
  let fullResync = !cal.sync_token;

  if (account.provider === "google") {
    let page = await fetchGooglePages(account.id, cal.ext_calendar_id, {
      syncToken: cal.sync_token,
      timeMin,
      timeMax,
    });
    if (page.gone) {
      fullResync = true;
      page = await fetchGooglePages(account.id, cal.ext_calendar_id, { timeMin, timeMax });
    }
    parsed = page.items
      .map((it) => parseGoogleEvent(it as Parameters<typeof parseGoogleEvent>[0]))
      .filter((p): p is ParsedEvent => p !== null);
    newCursor = page.nextSyncToken;
  } else {
    let page = await fetchGraphPages(account.id, cal.ext_calendar_id, {
      deltaLink: cal.sync_token,
      timeMin,
      timeMax,
    });
    if (page.gone) {
      fullResync = true;
      page = await fetchGraphPages(account.id, cal.ext_calendar_id, { timeMin, timeMax });
    }
    parsed = page.items
      .map((it) => parseGraphEvent(it as Parameters<typeof parseGraphEvent>[0]))
      .filter((p): p is ParsedEvent => p !== null);
    newCursor = page.deltaLink;
  }

  const applied = await applyEvents(
    svc,
    { userId, accountId: account.id, calendarId: cal.id },
    parsed,
    fullResync
  );

  await svc
    .from("calendars")
    .update({ sync_token: newCursor, last_synced_at: new Date().toISOString() })
    .eq("id", cal.id);

  return applied;
}

// Sync every sync-enabled calendar for one account. A revoked grant (already
// flipped to needs_reauth by the token layer) is a graceful skip.
async function syncAccount(
  svc: Svc,
  account: AccountRow,
  userId: string
): Promise<AccountSyncResult> {
  if (account.status !== "connected") {
    return { slot: account.slot, status: account.status, upserted: 0, deleted: 0, skipped: account.status };
  }
  const { data: cals } = await svc
    .from("calendars")
    .select("id, account_id, ext_calendar_id, sync_token")
    .eq("account_id", account.id)
    .eq("sync_enabled", true);

  let upserted = 0;
  let deleted = 0;
  for (const cal of (cals ?? []) as CalendarRow[]) {
    try {
      const r = await syncOneCalendar(svc, account, cal, userId);
      upserted += r.upserted;
      deleted += r.deleted;
    } catch (e) {
      if (e instanceof TokenRevokedError) {
        // The account is now needs_reauth; the rest of its calendars will also
        // fail. Stop here and report a clean skip. The amber banner tells the user.
        return {
          slot: account.slot,
          status: "needs_reauth",
          upserted,
          deleted,
          skipped: "needs_reauth",
        };
      }
      return {
        slot: account.slot,
        status: account.status,
        upserted,
        deleted,
        error: e instanceof Error ? e.message : "sync failed",
      };
    }
  }
  return { slot: account.slot, status: account.status, upserted, deleted };
}

// Public entry: sync all of a user's connected accounts, then run the reminder
// retry sweep. Never throws to the caller; each account reports its own result.
export async function syncAllEvents(userId: string): Promise<AccountSyncResult[]> {
  const svc = createServiceClient();
  const { data: accounts } = await svc
    .from("accounts")
    .select("id, slot, provider, status")
    .eq("user_id", userId)
    .in("status", ["connected", "needs_reauth"]);

  const results: AccountSyncResult[] = [];
  for (const acct of (accounts ?? []) as AccountRow[]) {
    results.push(await syncAccount(svc, acct, userId));
  }

  // Best-effort: create any reminder events that could not be written earlier
  // (for example while ca.tapasnr was in needs_reauth).
  try {
    await retryPendingReminders(userId);
  } catch {
    // never let a reminder retry failure break the calendar sync
  }
  return results;
}

// Staleness snapshot for the calendar page: the oldest last_synced_at across a
// user's sync-enabled calendars on connected accounts.
export async function newestStaleness(userId: string): Promise<{ stale: boolean; lastSyncedAt: string | null }> {
  const svc = createServiceClient();
  const { data: accounts } = await svc
    .from("accounts")
    .select("id")
    .eq("user_id", userId)
    .eq("status", "connected");
  const accountIds = (accounts ?? []).map((a) => a.id);
  if (accountIds.length === 0) return { stale: false, lastSyncedAt: null };

  const { data: cals } = await svc
    .from("calendars")
    .select("last_synced_at")
    .in("account_id", accountIds)
    .eq("sync_enabled", true);

  if (!cals || cals.length === 0) return { stale: false, lastSyncedAt: null };
  // Stale if any calendar has never synced or the oldest sync is past the window.
  let oldest: string | null = null;
  let anyNull = false;
  for (const c of cals) {
    if (!c.last_synced_at) {
      anyNull = true;
      break;
    }
    if (!oldest || c.last_synced_at < oldest) oldest = c.last_synced_at;
  }
  if (anyNull) return { stale: true, lastSyncedAt: null };
  return { stale: isStale(oldest), lastSyncedAt: oldest };
}
