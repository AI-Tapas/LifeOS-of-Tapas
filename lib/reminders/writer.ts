// Reminders on Google Calendar (the heart of M3). A task with a due date or an
// active recurring obligation writes ONE Google Calendar event to the
// reminder-home calendar (on ca.tapasnr) with four reminder overrides
// (7/3/1/0 days by default). Google fires the notifications whether the app is
// open or closed.
//
// Structural rule, enforced here and tested: the writer targets ONLY the
// is_reminder_home calendar. It resolves that calendar itself and calls
// assertReminderHome; there is no parameter to point it anywhere else.
//
// All provider calls go through withResourceAuth. If ca.tapasnr is in
// needs_reauth at save time the source row is still saved, the reminders row is
// written with created = false and a "reconnect" reason is surfaced; the event
// is created on the next successful save or on the sync retry sweep.

import { withResourceAuth } from "@/lib/oauth/tokens";
import { createServiceClient } from "@/lib/supabase/service";
import { TokenRevokedError } from "@/lib/oauth/core";
import {
  buildGoogleReminderEvent,
  buildTripEvent,
  assertReminderHome,
  planFinanceReminder,
  planTaskReminder,
  runReminderCleanup,
  nextObligationDates,
  obligationSeriesRRule,
  parseDateKey,
  reminderTitle,
  type FinanceKeyDateType,
  type ObligationFrequency,
} from "@/lib/reminders/core";
import type { Database } from "@/lib/database.types";
import type { SupabaseClient } from "@supabase/supabase-js";

type Svc = SupabaseClient<Database>;

// Recurring obligation reminders anchor at 09:00 IST on the due date.
const REMINDER_HOUR_IST = 9;
const RECONNECT_REASON = "Reminder not set: reconnect ca.tapasnr";

// A reminder always belongs to exactly one parent. finance_item_id was carried
// through unused in M3 "so M7 reuses this exact path"; M7b does exactly that,
// and there is still only one writer.
export interface ReminderSource {
  task_id?: string | null;
  obligation_id?: string | null;
  finance_item_id?: string | null;
}

export interface ReminderWriteOutcome {
  created: boolean;
  removed?: boolean;
  extEventId?: string;
  reason?: string;
}

interface HomeCalendar {
  id: string;
  account_id: string;
  ext_calendar_id: string;
  is_reminder_home: boolean;
}
interface ReminderHome {
  calendar: HomeCalendar;
  accountId: string;
  accountStatus: Database["public"]["Enums"]["account_status"];
}

// ---------------------------------------------------------------------------
// Reminder-home resolution + guard
// ---------------------------------------------------------------------------
async function resolveReminderHome(
  svc: Svc,
  userId: string
): Promise<{ home?: ReminderHome; reason?: string }> {
  const { data: cal } = await svc
    .from("calendars")
    .select("id, account_id, ext_calendar_id, is_reminder_home")
    .eq("user_id", userId)
    .eq("is_reminder_home", true)
    .maybeSingle();
  if (!cal) return { reason: "No reminder-home calendar is configured." };
  // Structural enforcement: refuse anything that is not the reminder-home.
  assertReminderHome(cal);
  const { data: acct } = await svc
    .from("accounts")
    .select("id, status")
    .eq("id", cal.account_id)
    .single();
  if (!acct) return { reason: "The reminder-home account is missing." };
  return {
    home: {
      calendar: cal as HomeCalendar,
      accountId: acct.id,
      accountStatus: acct.status,
    },
  };
}

// ---------------------------------------------------------------------------
// Google Calendar event calls (reminder-home account only), via withResourceAuth
// ---------------------------------------------------------------------------
function gcalUrl(calExtId: string, extEventId?: string): string {
  const base = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(
    calExtId
  )}/events`;
  return extEventId ? `${base}/${encodeURIComponent(extEventId)}` : base;
}

async function gcalCreate(
  accountId: string,
  calExtId: string,
  payload: unknown
): Promise<string> {
  // sendUpdates=none: a reminder is a solo event; it never invites anyone.
  const res = await withResourceAuth(accountId, (token) =>
    fetch(`${gcalUrl(calExtId)}?sendUpdates=none`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(payload),
    })
  );
  if (!res.ok) throw new Error(`gcal create ${res.status}`);
  const j = (await res.json()) as { id?: string };
  if (!j.id) throw new Error("gcal create returned no id");
  return j.id;
}

// Patch an existing reminder event. Returns false if the event is gone (404/410)
// so the caller can recreate it.
async function gcalPatch(
  accountId: string,
  calExtId: string,
  extEventId: string,
  payload: unknown
): Promise<boolean> {
  const res = await withResourceAuth(accountId, (token) =>
    fetch(`${gcalUrl(calExtId, extEventId)}?sendUpdates=none`, {
      method: "PATCH",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(payload),
    })
  );
  if (res.status === 404 || res.status === 410) return false;
  if (!res.ok) throw new Error(`gcal patch ${res.status}`);
  return true;
}

async function gcalDelete(
  accountId: string,
  calExtId: string,
  extEventId: string
): Promise<void> {
  const res = await withResourceAuth(accountId, (token) =>
    fetch(gcalUrl(calExtId, extEventId), {
      method: "DELETE",
      headers: { authorization: `Bearer ${token}` },
    })
  );
  // 404/410 mean it is already gone, which is fine.
  if (!res.ok && res.status !== 404 && res.status !== 410) {
    throw new Error(`gcal delete ${res.status}`);
  }
}

// ---------------------------------------------------------------------------
// Time helpers (IST is a fixed +05:30 offset)
// ---------------------------------------------------------------------------
function pad(n: number): string {
  return String(n).padStart(2, "0");
}
// A UTC instant as an IST-offset RFC3339 string, so Google expands recurrence
// on the correct IST date.
function toIstRfc3339(iso: string): string {
  const d = new Date(new Date(iso).getTime() + 330 * 60000);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(
    d.getUTCDate()
  )}T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}+05:30`;
}
function addMinutesRfc(iso: string, minutes: number): string {
  return toIstRfc3339(new Date(new Date(iso).getTime() + minutes * 60000).toISOString());
}

// ---------------------------------------------------------------------------
// reminders row helpers
// ---------------------------------------------------------------------------
function sourceFilter(svc: Svc, source: ReminderSource) {
  let q = svc.from("reminders").select("id, ext_event_id");
  if (source.task_id) q = q.eq("task_id", source.task_id);
  else if (source.obligation_id) q = q.eq("obligation_id", source.obligation_id);
  else if (source.finance_item_id) q = q.eq("finance_item_id", source.finance_item_id);
  return q;
}

async function findReminderRow(
  svc: Svc,
  source: ReminderSource
): Promise<{ id: string; ext_event_id: string | null } | null> {
  const { data } = await sourceFilter(svc, source).maybeSingle();
  return data ?? null;
}

async function saveReminderRow(
  svc: Svc,
  userId: string,
  source: ReminderSource,
  fields: { remind_ts: string; ext_event_id: string | null; created: boolean }
): Promise<void> {
  const existing = await findReminderRow(svc, source);
  const row = {
    user_id: userId,
    task_id: source.task_id ?? null,
    obligation_id: source.obligation_id ?? null,
    finance_item_id: source.finance_item_id ?? null,
    remind_ts: fields.remind_ts,
    ext_event_id: fields.ext_event_id,
    channel: "gcal" as const,
    created: fields.created,
  };
  if (existing) {
    await svc.from("reminders").update(row).eq("id", existing.id);
  } else {
    await svc.from("reminders").insert(row);
  }
}

// ---------------------------------------------------------------------------
// The single write path used by tasks, obligations (and later finance items)
// ---------------------------------------------------------------------------
interface ReminderSpec {
  title: string;
  anchorIso: string; // UTC instant the reminder event starts at
  offsetsDays: number[];
  rrule?: string;
}

async function writeReminder(
  svc: Svc,
  userId: string,
  source: ReminderSource,
  spec: ReminderSpec
): Promise<ReminderWriteOutcome> {
  const { home, reason } = await resolveReminderHome(svc, userId);
  if (!home) {
    await saveReminderRow(svc, userId, source, {
      remind_ts: spec.anchorIso,
      ext_event_id: null,
      created: false,
    });
    return { created: false, reason: reason ?? RECONNECT_REASON };
  }
  // ca.tapasnr revoked: save the row, defer the event to the retry sweep.
  if (home.accountStatus !== "connected") {
    await saveReminderRow(svc, userId, source, {
      remind_ts: spec.anchorIso,
      ext_event_id: null,
      created: false,
    });
    return { created: false, reason: RECONNECT_REASON };
  }

  const payload = buildGoogleReminderEvent({
    title: spec.title,
    startDateTime: toIstRfc3339(spec.anchorIso),
    endDateTime: addMinutesRfc(spec.anchorIso, 15),
    offsetsDays: spec.offsetsDays,
    rrule: spec.rrule,
  });

  const existing = await findReminderRow(svc, source);
  try {
    let extEventId: string;
    if (existing?.ext_event_id) {
      const patched = await gcalPatch(
        home.accountId,
        home.calendar.ext_calendar_id,
        existing.ext_event_id,
        payload
      );
      extEventId = patched
        ? existing.ext_event_id
        : await gcalCreate(home.accountId, home.calendar.ext_calendar_id, payload);
    } else {
      extEventId = await gcalCreate(
        home.accountId,
        home.calendar.ext_calendar_id,
        payload
      );
    }
    await saveReminderRow(svc, userId, source, {
      remind_ts: spec.anchorIso,
      ext_event_id: extEventId,
      created: true,
    });
    return { created: true, extEventId };
  } catch (e) {
    // Revoked mid-write: keep the row, defer to retry, surface reconnect.
    await saveReminderRow(svc, userId, source, {
      remind_ts: spec.anchorIso,
      ext_event_id: existing?.ext_event_id ?? null,
      created: false,
    });
    if (e instanceof TokenRevokedError) return { created: false, reason: RECONNECT_REASON };
    return {
      created: false,
      reason: e instanceof Error ? e.message : "Reminder could not be set.",
    };
  }
}

async function removeReminder(
  svc: Svc,
  userId: string,
  source: ReminderSource
): Promise<void> {
  const { home } = await resolveReminderHome(svc, userId);
  const canDelete = !!home && home.accountStatus === "connected";
  await runReminderCleanup({
    load: async () => {
      const { data } = await sourceFilter(svc, source);
      return (data ?? []).map((r) => ({ id: r.id, ext_event_id: r.ext_event_id }));
    },
    deleteEvent: async (extId) => {
      // Only attempt the provider delete when ca.tapasnr is reachable; the row
      // is removed regardless so the source can be deleted cleanly.
      if (canDelete && home) {
        await gcalDelete(home.accountId, home.calendar.ext_calendar_id, extId);
      }
    },
    deleteRow: async (id) => {
      await svc.from("reminders").delete().eq("id", id);
    },
  });
}

// ---------------------------------------------------------------------------
// Public API: tasks
// ---------------------------------------------------------------------------
export async function syncTaskReminder(
  userId: string,
  taskId: string
): Promise<ReminderWriteOutcome> {
  const svc = createServiceClient();
  const { data: task } = await svc
    .from("tasks")
    .select("id, title, due_ts, remind_offsets, status, reminder_mode, trips(title)")
    .eq("id", taskId)
    .single();
  if (!task) return { created: false, reason: "Task not found." };

  // No due date, the task is finished, or he keeps this one in the app: there
  // should be no calendar event. The same removal path covers all three, so
  // switching a task to in_app deletes the event it already had and can never
  // leave an orphan behind. The decision itself is pure (reminders/core.ts).
  if (planTaskReminder(task) === "remove") {
    await removeReminder(svc, userId, { task_id: taskId });
    return { created: false, removed: true };
  }
  return writeReminder(
    svc,
    userId,
    { task_id: taskId },
    {
      // A checklist step's own title is bare ("Book onward ticket"), which is
      // useless on a phone with three trips in flight, so the trip rides
      // along. Ordinary tasks are unchanged.
      title: reminderTitle(task.title, (task.trips as { title: string } | null)?.title),
      anchorIso: task.due_ts!,
      offsetsDays: task.remind_offsets ?? [7, 3, 1, 0],
    }
  );
}

export async function removeTaskReminder(userId: string, taskId: string): Promise<void> {
  const svc = createServiceClient();
  await removeReminder(svc, userId, { task_id: taskId });
}

// ---------------------------------------------------------------------------
// Public API: recurring obligations
// ---------------------------------------------------------------------------
export async function syncObligationReminder(
  userId: string,
  obligationId: string
): Promise<ReminderWriteOutcome> {
  const svc = createServiceClient();
  const { data: ob } = await svc
    .from("recurring_obligations")
    .select(
      "id, name, frequency, due_day, due_month, interval_rule, anchor_date, remind_offsets, active"
    )
    .eq("id", obligationId)
    .single();
  if (!ob) return { created: false, reason: "Obligation not found." };

  if (!ob.active) {
    await removeReminder(svc, userId, { obligation_id: obligationId });
    return { created: false, removed: true };
  }

  // One entry point for both families: the monthly enum and the sub-monthly
  // custom series (B2). The anchor is the first date of the same series the
  // screen shows him, so what he reads and what Google expands cannot differ.
  const series = {
    frequency: ob.frequency as ObligationFrequency,
    due_day: ob.due_day,
    due_month: ob.due_month,
    interval_rule: ob.interval_rule,
    anchor_date: ob.anchor_date,
  };
  const rrule = obligationSeriesRRule(series);
  const today = (() => {
    const d = new Date(Date.now() + 330 * 60000);
    return { y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, d: d.getUTCDate() };
  })();
  const first = parseDateKey(nextObligationDates(series, today, 1)[0]);
  const anchorRfc = `${first.y}-${pad(first.m)}-${pad(first.d)}T${pad(
    REMINDER_HOUR_IST
  )}:00:00+05:30`;
  const anchorIso = new Date(anchorRfc).toISOString();

  return writeReminder(
    svc,
    userId,
    { obligation_id: obligationId },
    {
      title: `Reminder: ${ob.name}`,
      anchorIso,
      offsetsDays: ob.remind_offsets ?? [7, 3, 1, 0],
      rrule,
    }
  );
}

export async function removeObligationReminder(
  userId: string,
  obligationId: string
): Promise<void> {
  const svc = createServiceClient();
  await removeReminder(svc, userId, { obligation_id: obligationId });
}

// ---------------------------------------------------------------------------
// Public API: investments (M7b)
// ---------------------------------------------------------------------------
// The same writer, the same reminder-home resolution, the same offsets. A
// maturity is a calendar interrupt because money is genuinely at stake on the
// day; a review date is in-app and writes nothing here, and the same removal
// path covers switching one to the other, so no orphan event is left behind.
export async function syncFinanceReminder(
  userId: string,
  financeItemId: string
): Promise<ReminderWriteOutcome> {
  const svc = createServiceClient();
  const { data: item } = await svc
    .from("finance_items")
    .select("id, name, institution, key_date, key_date_type, remind")
    .eq("id", financeItemId)
    .single();
  if (!item) return { created: false, reason: "Holding not found." };

  const state = {
    key_date: item.key_date,
    key_date_type: item.key_date_type as FinanceKeyDateType | null,
    remind: item.remind,
  };
  if (planFinanceReminder(state) === "remove") {
    await removeReminder(svc, userId, { finance_item_id: financeItemId });
    return { created: false, removed: true };
  }

  const anchorIso = new Date(
    `${item.key_date}T${pad(REMINDER_HOUR_IST)}:00:00+05:30`
  ).toISOString();
  const where = item.institution ? ` (${item.institution})` : "";
  return writeReminder(
    svc,
    userId,
    { finance_item_id: financeItemId },
    {
      title: `Maturing: ${item.name}${where}`,
      anchorIso,
      // The standard offsets. A maturity is exactly the case the 7/3/1/0 set
      // was designed for: enough notice to actually redirect the money.
      offsetsDays: [7, 3, 1, 0],
    }
  );
}

export async function removeFinanceReminder(
  userId: string,
  financeItemId: string
): Promise<void> {
  const svc = createServiceClient();
  await removeReminder(svc, userId, { finance_item_id: financeItemId });
}

// ---------------------------------------------------------------------------
// Public API: trips (M7a). ONE all-day event per trip, not one per step.
// ---------------------------------------------------------------------------
// Same reminder-home resolution, same withResourceAuth, same create/patch/
// delete calls as every other reminder: there is no second calendar path.
// The event id lives on the trip row, because this is not a reminder about a
// due date, it is the trip itself.
export async function syncTripEvent(
  userId: string,
  tripId: string
): Promise<ReminderWriteOutcome> {
  const svc = createServiceClient();
  const { data: trip } = await svc
    .from("trips")
    .select("id, title, cities, start_date, end_date, ext_event_id")
    .eq("id", tripId)
    .single();
  if (!trip) return { created: false, reason: "Trip not found." };

  // No start date, nothing to span. If an event was written earlier and the
  // date has since been cleared, it goes.
  if (!trip.start_date) {
    await removeTripEvent(userId, tripId);
    return { created: false, removed: true };
  }

  const { home, reason } = await resolveReminderHome(svc, userId);
  if (!home) return { created: false, reason: reason ?? RECONNECT_REASON };
  if (home.accountStatus !== "connected") {
    return { created: false, reason: RECONNECT_REASON };
  }

  const payload = buildTripEvent({
    title: trip.title,
    cities: Array.isArray(trip.cities) ? (trip.cities as string[]) : [],
    startDate: trip.start_date,
    endDate: trip.end_date,
  });

  try {
    let extEventId: string;
    if (trip.ext_event_id) {
      const patched = await gcalPatch(
        home.accountId,
        home.calendar.ext_calendar_id,
        trip.ext_event_id,
        payload
      );
      extEventId = patched
        ? trip.ext_event_id
        : await gcalCreate(home.accountId, home.calendar.ext_calendar_id, payload);
    } else {
      extEventId = await gcalCreate(
        home.accountId,
        home.calendar.ext_calendar_id,
        payload
      );
    }
    await svc.from("trips").update({ ext_event_id: extEventId }).eq("id", tripId);
    return { created: true, extEventId };
  } catch (e) {
    if (e instanceof TokenRevokedError) return { created: false, reason: RECONNECT_REASON };
    return {
      created: false,
      reason: e instanceof Error ? e.message : "The trip could not be put on the calendar.",
    };
  }
}

export async function removeTripEvent(userId: string, tripId: string): Promise<void> {
  const svc = createServiceClient();
  const { data: trip } = await svc
    .from("trips")
    .select("id, ext_event_id")
    .eq("id", tripId)
    .maybeSingle();
  if (!trip?.ext_event_id) return;
  const { home } = await resolveReminderHome(svc, userId);
  if (home && home.accountStatus === "connected") {
    await gcalDelete(home.accountId, home.calendar.ext_calendar_id, trip.ext_event_id);
  }
  // Cleared either way, so a later sync writes a fresh event rather than
  // patching one that may already be gone.
  await svc.from("trips").update({ ext_event_id: null }).eq("id", tripId);
}

// ---------------------------------------------------------------------------
// One-off maintenance (M7a). SQL cannot delete a Google Calendar event, so
// the migration that switched roughly thirty checklist steps to in_app left
// their events standing on the calendar. This walks every in_app task whose
// reminders row still holds an ext_event_id and removes the event through the
// normal removeReminder path.
//
// Safe to run twice: the second run finds no rows. Owner-session only (the
// Settings action), on no tool surface, and never run automatically.
// ---------------------------------------------------------------------------
export async function sweepInAppReminderEvents(
  userId: string
): Promise<{ cleared: number; skipped: number }> {
  const svc = createServiceClient();
  const { data: rows } = await svc
    .from("reminders")
    .select("id, task_id, ext_event_id, tasks(reminder_mode)")
    .eq("user_id", userId)
    .not("task_id", "is", null)
    .not("ext_event_id", "is", null);

  let cleared = 0;
  let skipped = 0;
  for (const row of rows ?? []) {
    const mode = (row.tasks as { reminder_mode: string } | null)?.reminder_mode;
    if (mode !== "in_app" || !row.task_id) continue;
    try {
      await removeReminder(svc, userId, { task_id: row.task_id });
      cleared += 1;
    } catch {
      // A single unreachable event must not stop the sweep; the next run
      // picks it up, because the row is only removed on success.
      skipped += 1;
    }
  }
  return { cleared, skipped };
}

// ---------------------------------------------------------------------------
// Retry sweep (called from event sync). Attempts to create reminder events that
// could not be written earlier, for example while ca.tapasnr was revoked.
// ---------------------------------------------------------------------------
export async function retryPendingReminders(userId: string): Promise<number> {
  const svc = createServiceClient();
  const { home } = await resolveReminderHome(svc, userId);
  // Nothing to retry against if the reminder-home is unreachable.
  if (!home || home.accountStatus !== "connected") return 0;

  const { data: pending } = await svc
    .from("reminders")
    .select("id, task_id, obligation_id, finance_item_id")
    .eq("user_id", userId)
    .eq("channel", "gcal")
    .eq("created", false);

  let created = 0;
  for (const r of pending ?? []) {
    try {
      const outcome = r.task_id
        ? await syncTaskReminder(userId, r.task_id)
        : r.obligation_id
          ? await syncObligationReminder(userId, r.obligation_id)
          : r.finance_item_id
            ? await syncFinanceReminder(userId, r.finance_item_id)
            : null;
      if (outcome?.created) created += 1;
    } catch {
      // leave it pending for the next sweep
    }
  }
  return created;
}
