// B29. Keeps the family travel calendar right. Server only.
//
// syncFamilyTravel(owner) computes what the calendar should hold
// (lib/family/travel.ts, pure) and creates, updates or deletes ONLY the events
// recorded in family_travel_events. It runs after every trip or leg write and
// once a day from the 7 AM brief cron as a repair pass. It never throws and
// never blocks the write that called it; a failure leaves an audit row with
// counts and a short reason, never any event text.
//
// Writes go through the same Google calendar calls as every other reminder
// (lib/reminders/writer.ts), so every one is inside withResourceAuth.
// ponytail: no lock, so two syncs in the same second could both create an
// event. One user, one writer at a time in practice; add a row lock if the
// duplicate ever shows.

import { createServiceClient } from "@/lib/supabase/service";
import { TokenRevokedError } from "@/lib/oauth/core";
import { gcalCreate, gcalDelete, gcalPatch } from "@/lib/reminders/writer";
import { civilKey, civilToday } from "@/lib/datetime";
import {
  desiredFamilyEvents,
  familyPatchBody,
  runFamilySync,
  type FamilyIO,
  type FamilySyncResult,
  type FamilyTrip,
} from "@/lib/family/travel";
import type { Database, Json } from "@/lib/database.types";
import type { SupabaseClient } from "@supabase/supabase-js";

type Svc = SupabaseClient<Database>;

export interface FamilyCalendar {
  id: string;
  account_id: string;
  ext_calendar_id: string;
}

export type FamilySyncOutcome =
  | ({ ran: true } & FamilySyncResult)
  | { ran: false; reason: string };

async function familyCalendar(svc: Svc, userId: string): Promise<FamilyCalendar | null> {
  const { data } = await svc
    .from("calendars")
    .select("id, account_id, ext_calendar_id")
    .eq("user_id", userId)
    .eq("is_family_travel", true)
    .maybeSingle();
  return data ?? null;
}

// One run against one calendar. `trips` empty means "desire nothing", which
// deletes every recorded event (used when the feature is switched off).
async function runOn(
  svc: Svc,
  userId: string,
  cal: FamilyCalendar,
  trips: FamilyTrip[]
): Promise<FamilySyncResult> {
  const { data: recorded } = await svc
    .from("family_travel_events")
    .select("id, trip_id, kind, item_key, ext_event_id, content_hash")
    .eq("user_id", userId);

  const io: FamilyIO = {
    create: (payload) => gcalCreate(cal.account_id, cal.ext_calendar_id, payload),
    patch: (extId, payload) => gcalPatch(cal.account_id, cal.ext_calendar_id, extId, familyPatchBody(payload)),
    remove: (extId) => gcalDelete(cal.account_id, cal.ext_calendar_id, extId),
    record: async (row) => {
      const { id, ...rest } = row;
      const { error } = id
        ? await svc.from("family_travel_events").update(rest).eq("id", id)
        : await svc.from("family_travel_events").insert({ user_id: userId, ...rest });
      if (error) throw new Error("could not record the event");
    },
    forget: async (id) => {
      const { error } = await svc.from("family_travel_events").delete().eq("id", id);
      if (error) throw new Error("could not forget the event");
    },
  };
  const desired = trips.length ? desiredFamilyEvents(trips, civilKey(civilToday())) : [];
  return runFamilySync(desired, recorded ?? [], io);
}

async function logFailure(svc: Svc, userId: string, reason: string, result?: FamilySyncResult) {
  try {
    await svc.from("audit_log").insert({
      user_id: userId,
      actor: "assistant",
      action: "family_travel_sync_failed",
      entity: "calendars",
      // Counts and a short reason only. No event text of any kind.
      meta: { reason, ...(result ?? {}) } as Json,
    });
  } catch {
    // nothing more can be done
  }
}

export async function syncFamilyTravel(userId: string): Promise<FamilySyncOutcome> {
  const svc = createServiceClient();
  try {
    const cal = await familyCalendar(svc, userId);
    if (!cal) return { ran: false, reason: "off" };
    const { data: acct } = await svc.from("accounts").select("status").eq("id", cal.account_id).maybeSingle();
    if (acct?.status !== "connected") {
      return { ran: false, reason: "account not connected" };
    }
    const { data: trips } = await svc
      .from("trips")
      .select("id, status, session_date, cities, legs")
      .eq("user_id", userId)
      .neq("status", "cancelled");
    const result = await runOn(svc, userId, cal, trips ?? []);
    if (result.failed) await logFailure(svc, userId, "some events could not be written", result);
    return { ran: true, ...result };
  } catch (e) {
    const reason = e instanceof TokenRevokedError ? "account needs reconnecting" : "sync failed";
    await logFailure(svc, userId, reason);
    return { ran: false, reason };
  }
}

// Switching the feature off, or to another calendar: delete every event Life
// OS recorded, from the calendar it was written to. Called by the Settings
// action BEFORE the flag moves, since the flag is how the calendar is found.
export async function clearFamilyTravel(userId: string): Promise<FamilySyncOutcome> {
  const svc = createServiceClient();
  try {
    const cal = await familyCalendar(svc, userId);
    if (!cal) return { ran: false, reason: "off" };
    const result = await runOn(svc, userId, cal, []);
    return { ran: true, ...result };
  } catch (e) {
    const reason = e instanceof TokenRevokedError ? "account needs reconnecting" : "clear failed";
    await logFailure(svc, userId, reason);
    return { ran: false, reason };
  }
}
