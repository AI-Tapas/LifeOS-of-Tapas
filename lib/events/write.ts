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

// icai holds calendar.readonly only; writes are structurally refused.
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

  const id = await upsertAppEvent(
    svc,
    userId,
    { accountId: account.id, calendarId: cal.id, extEventId: j.id },
    input
  );
  return { id, extEventId: j.id };
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
    .select("id, account_id, calendar_id, ext_event_id")
    .eq("id", eventId)
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

  const payload = prepareEventWrite(account.provider, input, confirmed);
  const hasAttendees = (input.attendees?.length ?? 0) > 0;

  let url = providerUrl(account.provider, cal.ext_calendar_id, ev.ext_event_id);
  const method = account.provider === "google" ? "PATCH" : "PATCH";
  if (account.provider === "google") {
    url += `?sendUpdates=${hasAttendees ? "all" : "none"}`;
  }
  const res = await withResourceAuth(account.id, (token) =>
    fetch(url, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(payload),
    })
  );
  if (!res.ok) throw new Error(`${account.provider} event update ${res.status}`);

  const id = await upsertAppEvent(
    svc,
    userId,
    { accountId: account.id, calendarId: ev.calendar_id, extEventId: ev.ext_event_id },
    input
  );
  return { id, extEventId: ev.ext_event_id };
}

// ---------------------------------------------------------------------------
// Delete: only app-created events (never external data we merely synced).
// ---------------------------------------------------------------------------
export async function deleteAppEvent(userId: string, eventId: string): Promise<void> {
  const svc = createServiceClient();
  const { data: ev } = await svc
    .from("events")
    .select("id, account_id, calendar_id, ext_event_id, source")
    .eq("id", eventId)
    .single();
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
  if (cal && ev.ext_event_id) {
    const url = providerUrl(account.provider, cal.ext_calendar_id, ev.ext_event_id);
    const res = await withResourceAuth(account.id, (token) =>
      fetch(url, { method: "DELETE", headers: { authorization: `Bearer ${token}` } })
    );
    if (!res.ok && res.status !== 404 && res.status !== 410) {
      throw new Error(`${account.provider} event delete ${res.status}`);
    }
  }
  await svc.from("events").delete().eq("id", eventId);
}

export type { AppEventInput, GoogleEventBody, GraphEventBody };
