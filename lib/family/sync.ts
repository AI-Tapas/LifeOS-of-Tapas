// B29. Keeps the family travel calendar right. Server only.
//
// syncFamilyTravel(owner) computes what the calendar should hold
// (lib/family/travel.ts, pure) and creates, updates or deletes ONLY the events
// recorded in family_travel_events. It runs after every trip or leg write and
// once a day from the 7 AM brief cron as a repair pass. It never throws and
// never blocks the write that called it; a failure leaves an audit row with
// counts and a short reason, never any event text.
//
// SAFETY: every read it depends on (the trips, the work stream names, the
// recorded events, the calendar rows) is checked. A failed read stops the run
// BEFORE any Google call, because an error read as an empty list would delete
// every event or create them all twice. Only clearFamilyTravel passes an
// explicit empty desired set.
//
// Every delete and patch goes to the calendar the event was RECORDED on
// (family_travel_events.ext_calendar_id), never to whichever calendar is
// chosen now.
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
  type DesiredEvent,
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

// A read that failed. Thrown inside this module only, and caught by the two
// public functions, before any Google call is made.
class ReadFailed extends Error {}

async function familyCalendar(svc: Svc, userId: string): Promise<FamilyCalendar | null> {
  const { data, error } = await svc
    .from("calendars")
    .select("id, account_id, ext_calendar_id")
    .eq("user_id", userId)
    .eq("is_family_travel", true)
    .maybeSingle();
  if (error) throw new ReadFailed("calendar read failed");
  return data ?? null;
}

// Runs the plan. `current` is the chosen family calendar (new events go there);
// `trips` null means "desire nothing" (clear), which is the ONLY way to an empty
// desired set that is not simply what the trips say.
async function runOn(
  svc: Svc,
  userId: string,
  current: FamilyCalendar | null,
  trips: FamilyTrip[] | null,
  streamNames: string[]
): Promise<FamilySyncResult> {
  const { data: recorded, error } = await svc
    .from("family_travel_events")
    .select("id, trip_id, kind, item_key, ext_event_id, ext_calendar_id, content_hash")
    .eq("user_id", userId);
  if (error || !recorded) throw new ReadFailed("recorded events read failed");

  // ext_calendar_id -> account, for every calendar a record may sit on.
  const { data: cals, error: calErr } = await svc
    .from("calendars")
    .select("account_id, ext_calendar_id")
    .eq("user_id", userId);
  if (calErr || !cals) throw new ReadFailed("calendars read failed");
  const accountOf = (extCalendarId: string) => {
    const hit = cals.find((c) => c.ext_calendar_id === extCalendarId);
    if (!hit) throw new Error("calendar no longer known");
    return hit.account_id;
  };

  const io: FamilyIO = {
    create: (payload) => {
      if (!current) throw new Error("no family calendar");
      return gcalCreate(current.account_id, current.ext_calendar_id, payload);
    },
    patch: (calId, extId, payload) => gcalPatch(accountOf(calId), calId, extId, familyPatchBody(payload)),
    remove: (calId, extId) => gcalDelete(accountOf(calId), calId, extId),
    record: async (row) => {
      const { id, ...rest } = row;
      const { error: e } = id
        ? await svc.from("family_travel_events").update(rest).eq("id", id)
        : await svc.from("family_travel_events").insert({ user_id: userId, ...rest });
      if (e) throw new Error("could not record the event");
    },
    forget: async (id) => {
      const { error: e } = await svc.from("family_travel_events").delete().eq("id", id);
      if (e) throw new Error("could not forget the event");
    },
  };
  const desired: DesiredEvent[] =
    trips === null ? [] : desiredFamilyEvents(trips, civilKey(civilToday()), streamNames);
  return runFamilySync(desired, recorded, io, current?.ext_calendar_id ?? "");
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
    const { data: acct, error: acctErr } = await svc
      .from("accounts")
      .select("status")
      .eq("id", cal.account_id)
      .maybeSingle();
    if (acctErr) throw new ReadFailed("account read failed");
    if (acct?.status !== "connected") {
      return { ran: false, reason: "account not connected" };
    }
    const { data: trips, error: tripErr } = await svc
      .from("trips")
      .select("id, status, session_date, cities, legs")
      .eq("user_id", userId)
      .neq("status", "cancelled");
    if (tripErr || !trips) throw new ReadFailed("trips read failed");
    const { data: streams, error: streamErr } = await svc
      .from("work_streams")
      .select("name")
      .eq("user_id", userId);
    if (streamErr || !streams) throw new ReadFailed("work streams read failed");

    const result = await runOn(svc, userId, cal, trips, streams.map((s) => s.name));
    if (result.failed) await logFailure(svc, userId, "some events could not be written", result);
    return { ran: true, ...result };
  } catch (e) {
    const reason =
      e instanceof TokenRevokedError ? "account needs reconnecting" : e instanceof ReadFailed ? e.message : "sync failed";
    await logFailure(svc, userId, reason);
    return { ran: false, reason };
  }
}

// Switching the feature off, or to another calendar: delete every event Life
// OS recorded, each from the calendar it was recorded on. Called by the
// Settings action BEFORE the flag moves.
export async function clearFamilyTravel(userId: string): Promise<FamilySyncOutcome> {
  const svc = createServiceClient();
  try {
    const result = await runOn(svc, userId, null, null, []);
    return { ran: true, ...result };
  } catch (e) {
    const reason =
      e instanceof TokenRevokedError ? "account needs reconnecting" : e instanceof ReadFailed ? e.message : "clear failed";
    await logFailure(svc, userId, reason);
    return { ran: false, reason };
  }
}
