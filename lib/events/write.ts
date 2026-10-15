// Event write path. Creates and edits events on each account's is_primary_write
// calendar (edits to a synced event write back to its own source calendar).
// icai is read-only: writes are refused. Solo events save directly; events with
// attendees require the confirmed flag, enforced here in code (prepareEventWrite
// throws ConfirmationRequiredError otherwise), not only in the UI.

import { withResourceAuth } from "@/lib/oauth/tokens";
import { createServiceClient } from "@/lib/supabase/service";
import {
  prepareEventWrite,
  ConfirmationRequiredError,
  type AppEventInput,
  type GoogleEventBody,
  type GraphEventBody,
} from "@/lib/events/payload";
import type { Provider } from "@/lib/accounts";
import type { Database, Json } from "@/lib/database.types";
import type { SupabaseClient } from "@supabase/supabase-js";

type Svc = SupabaseClient<Database>;

export { ConfirmationRequiredError };

// icai holds the full calendar scope since B36, but its calendar stays read-only in code: writes are refused.
export class ReadOnlyAccountError extends Error {
  constructor(slot: string) {
    super(`The ${slot} account is read-only. Events cannot be created or edited on it.`);
    this.name = "ReadOnlyAccountError";
  }
}

export interface EventWriteResult {
  id: string;
  extEventId: string | null;
}

export class ProviderEventPersistenceError extends Error {
  readonly providerResult: Record<string, unknown>;
  constructor(message: string, providerResult: Record<string, unknown>) {
    super(message);
    this.name = "ProviderEventPersistenceError";
    this.providerResult = providerResult;
  }
}

interface AccountInfo {
  id: string;
  slot: string | null;
  provider: Provider;
  status: Database["public"]["Enums"]["account_status"];
}

async function loadAccount(svc: Svc, accountId: string): Promise<AccountInfo> {
  const { data, error } = await svc
    .from("accounts")
    .select("id, slot, provider, status")
    .eq("id", accountId)
    .single();
  if (error || !data) throw new Error("Account not found.");
  if (data.slot === "icai") throw new ReadOnlyAccountError("icai");
  if (data.status !== "connected") {
    throw new Error(`The ${data.slot ?? "account"} is ${data.status}.`);
  }
  return data as AccountInfo;
}

async function primaryWriteCalendar(
  svc: Svc,
  accountId: string
): Promise<{ id: string; ext_calendar_id: string }> {
  const { data } = await svc
    .from("calendars")
    .select("id, ext_calendar_id")
    .eq("account_id", accountId)
    .eq("is_primary_write", true)
    .maybeSingle();
  if (!data) throw new Error("No write-back calendar is set for this account.");
  return data;
}

function providerUrl(
  provider: Provider,
  calExtId: string,
  extEventId?: string
): string {
  if (provider === "google") {
    const base = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(
      calExtId
    )}/events`;
    return extEventId ? `${base}/${encodeURIComponent(extEventId)}` : base;
  }
  const base = `https://graph.microsoft.com/v1.0/me/calendars/${encodeURIComponent(
    calExtId
  )}/events`;
  return extEventId ? `${base}/${encodeURIComponent(extEventId)}` : base;
}

// A stored event can acquire guests outside LifeOS. Always inspect the current
// provider version, then bind the write to that version with If-Match. Missing
// version information fails closed; a provider race returns 412 for review.
async function currentProviderEvent(account: AccountInfo, url: string, allowMissing = false) {
  const response = await withResourceAuth(account.id, (token) =>
    fetch(url, { headers: { authorization: `Bearer ${token}` }, cache: "no-store" })
  );
  if (allowMissing && (response.status === 404 || response.status === 410)) return null;
  if (!response.ok) throw new Error(`Could not verify current event (${response.status}). Nothing was changed.`);
  const body = await response.json() as {
    etag?: string; "@odata.etag"?: string; attendeesOmitted?: boolean;
    attendees?: { email?: string; displayName?: string; emailAddress?: { address?: string; name?: string } }[];
  };
  if (body.attendeesOmitted === true) throw new Error("The provider returned an incomplete guest list. Nothing was changed.");
  const etag = response.headers.get("etag") ?? body.etag ?? body["@odata.etag"];
  if (!etag || /[\r\n]/.test(etag)) throw new Error("The provider supplied no event version. Refresh the calendar before trying again.");
  if (body.attendees !== undefined && !Array.isArray(body.attendees)) {
    throw new Error("Could not verify the current guest list. Nothing was changed.");
  }
  const attendees = (body.attendees ?? []).map((attendee) => {
    const email = attendee.email ?? attendee.emailAddress?.address;
    if (!email) throw new Error("Could not verify a calendar guest. Nothing was changed.");
    return { email, name: attendee.displayName ?? attendee.emailAddress?.name };
  });
  return { etag, attendees };
}

// Persist the event locally with source = 'app', keyed on (calendar_id,
// ext_event_id) so a later sync round-trips it without duplication.
async function upsertAppEvent(
  svc: Svc,
  userId: string,
  ctx: { accountId: string; calendarId: string; extEventId: string },
  input: AppEventInput
): Promise<string> {
  const { data, error } = await svc
    .from("events")
    .upsert(
      {
        user_id: userId,
        account_id: ctx.accountId,
        calendar_id: ctx.calendarId,
        ext_event_id: ctx.extEventId,
        title: input.title,
        description: input.description ?? null,
        location: input.location ?? null,
        start_ts: input.startIso,
        end_ts: input.endIso ?? null,
        all_day: !!input.allDay,
        attendees: (input.attendees ?? null) as Json,
        source: "app",
        updated_at: new Date().toISOString(),
      },
      { onConflict: "calendar_id,ext_event_id" }
    )
    .select("id")
    .single();
  if (error || !data) throw new Error(error?.message ?? "Could not save the event.");
  return data.id;
}

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------
export async function createEvent(
  userId: string,
  accountId: string,
  input: AppEventInput,
  confirmed: boolean
): Promise<EventWriteResult> {
  const svc = createServiceClient();
  const account = await loadAccount(svc, accountId);
  const cal = await primaryWriteCalendar(svc, accountId);

  // Confirmation gate (throws ConfirmationRequiredError on unconfirmed invites).
  const payload = prepareEventWrite(account.provider, input, confirmed);
  const hasAttendees = (input.attendees?.length ?? 0) > 0;

  let url = providerUrl(account.provider, cal.ext_calendar_id);
  if (account.provider === "google") {
    url += `?sendUpdates=${hasAttendees ? "all" : "none"}`;
  }
  const res = await withResourceAuth(account.id, (token) =>
    fetch(url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(payload),
    })
  );
  if (!res.ok) throw new Error(`${account.provider} event create ${res.status}`);
  const j = (await res.json()) as { id?: string };
  if (!j.id) throw new Error("Provider returned no event id.");

  try {
    const id = await upsertAppEvent(
      svc,
      userId,
      { accountId: account.id, calendarId: cal.id, extEventId: j.id },
      input
    );
    return { id, extEventId: j.id };
  } catch {
    throw new ProviderEventPersistenceError("The provider accepted the event change, but local history could not be saved. Do not repeat it; sync and reconcile the calendar.", {
      ext_event_id: j.id, account_id: account.id, calendar_id: cal.id,
    });
  }
}

// ---------------------------------------------------------------------------
// Edit (writes back to the event's own source calendar where scope allows)
// ---------------------------------------------------------------------------
export async function updateEvent(
  userId: string,
  eventId: string,
  input: AppEventInput,
  confirmed: boolean
): Promise<EventWriteResult> {
  const svc = createServiceClient();
  const { data: ev } = await svc
    .from("events")
    .select("id, account_id, calendar_id, ext_event_id, attendees")
    .eq("id", eventId)
    .eq("user_id", userId)
    .single();
  if (!ev || !ev.account_id || !ev.calendar_id || !ev.ext_event_id) {
    throw new Error("This event cannot be edited.");
  }
  const account = await loadAccount(svc, ev.account_id); // refuses icai
  const { data: cal } = await svc
    .from("calendars")
    .select("ext_calendar_id")
    .eq("id", ev.calendar_id)
    .single();
  if (!cal) throw new Error("Source calendar not found.");

  const baseUrl = providerUrl(account.provider, cal.ext_calendar_id, ev.ext_event_id);
  const current = await currentProviderEvent(account, baseUrl);
  if (!current) throw new Error("Event no longer exists.");
  const previousCount = Math.max(current.attendees.length, Array.isArray(ev.attendees) ? ev.attendees.length : 0);
  if (previousCount > 0 && !confirmed) throw new ConfirmationRequiredError(previousCount);
  const payload = prepareEventWrite(account.provider, input, confirmed);
  // An omitted field preserves guests. Explicit [] removes them, also gated
  // above because removing existing guests affects those guests.
  if (input.attendees !== undefined && input.attendees.length === 0) payload.attendees = [];
  const hasAttendees = previousCount > 0 || (input.attendees?.length ?? 0) > 0;
  const url = baseUrl + (account.provider === "google" ? `?sendUpdates=${hasAttendees ? "all" : "none"}` : "");
  const res = await withResourceAuth(account.id, (token) =>
    fetch(url, {
      method: "PATCH",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "if-match": current.etag,
      },
      body: JSON.stringify(payload),
    })
  );
  if (!res.ok) throw new Error(`${account.provider} event update ${res.status}`);

  try {
    const id = await upsertAppEvent(
      svc,
      userId,
      { accountId: account.id, calendarId: ev.calendar_id, extEventId: ev.ext_event_id },
      { ...input, attendees: input.attendees ?? current.attendees }
    );
    return { id, extEventId: ev.ext_event_id };
  } catch {
    throw new ProviderEventPersistenceError("The provider accepted the event change, but local history could not be saved. Do not repeat it; sync and reconcile the calendar.", {
      ext_event_id: ev.ext_event_id, account_id: account.id, calendar_id: ev.calendar_id,
    });
  }
}

// ---------------------------------------------------------------------------
// Delete: only app-created events (never external data we merely synced).
// ---------------------------------------------------------------------------
export async function deleteAppEvent(userId: string, eventId: string, confirmed = false): Promise<void> {
  const svc = createServiceClient();
  const { data: ev, error: readError } = await svc
    .from("events")
    .select("id, account_id, calendar_id, ext_event_id, source, attendees")
    .eq("id", eventId)
    .eq("user_id", userId)
    .maybeSingle();
  if (readError) throw new Error(readError.message);
  if (!ev) return;
  if (ev.source !== "app") {
    throw new Error("Only events created in the app can be deleted here.");
  }
  const account = await loadAccount(svc, ev.account_id!); // refuses icai
  const { data: cal } = await svc
    .from("calendars")
    .select("ext_calendar_id")
    .eq("id", ev.calendar_id!)
    .single();
  if (!cal || !ev.ext_event_id) throw new Error("The provider event could not be located. Refresh before deleting.");
  const baseUrl = providerUrl(account.provider, cal.ext_calendar_id, ev.ext_event_id);
  const current = await currentProviderEvent(account, baseUrl, true);
  if (current) {
    const count = Math.max(current.attendees.length, Array.isArray(ev.attendees) ? ev.attendees.length : 0);
    if (count > 0 && !confirmed) throw new ConfirmationRequiredError(count);
    const url = baseUrl + (account.provider === "google" ? `?sendUpdates=${count ? "all" : "none"}` : "");
    const res = await withResourceAuth(account.id, (token) =>
      fetch(url, { method: "DELETE", headers: { authorization: `Bearer ${token}`, "if-match": current.etag } })
    );
    if (!res.ok && res.status !== 404 && res.status !== 410) {
      throw new Error(`${account.provider} event delete ${res.status}. Refresh before trying again.`);
    }
  }
  const { error } = await svc.from("events").delete().eq("id", eventId).eq("user_id", userId);
  if (error) throw new ProviderEventPersistenceError("The provider event was deleted, but local history could not be saved. Sync the calendar; do not recreate the event.", { ext_event_id: ev.ext_event_id, deleted: true });
}

export type { AppEventInput, GoogleEventBody, GraphEventBody };
