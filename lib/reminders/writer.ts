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
  obligationRRule,
  assertReminderHome,
  runReminderCleanup,
  nextObligationDate,
  type ObligationFrequency,
} from "@/lib/reminders/core";
import type { Database } from "@/lib/database.types";
import type { SupabaseClient } from "@supabase/supabase-js";

type Svc = SupabaseClient<Database>;

// Recurring obligation reminders anchor at 09:00 IST on the due date.
const REMINDER_HOUR_IST = 9;
const RECONNECT_REASON = "Reminder not set: reconnect ca.tapasnr";

// A reminder always belongs to exactly one parent. finance_item_id is carried
// through unused in M3 so M7 reuses this exact path.
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
    .select("id, title, due_ts, remind_offsets, status")
    .eq("id", taskId)
    .single();
  if (!task) return { created: false, reason: "Task not found." };

  // No due date, or the task is finished: there should be no reminder.
  if (!task.due_ts || task.status === "done" || task.status === "dropped") {
    await removeReminder(svc, userId, { task_id: taskId });
    return { created: false, removed: true };
  }
  return writeReminder(
    svc,
    userId,
    { task_id: taskId },
    {
      title: `Reminder: ${task.title}`,
      anchorIso: task.due_ts,
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
    .select("id, name, frequency, due_day, due_month, remind_offsets, active")
    .eq("id", obligationId)
    .single();
  if (!ob) return { created: false, reason: "Obligation not found." };

  if (!ob.active) {
    await removeReminder(svc, userId, { obligation_id: obligationId });
    return { created: false, removed: true };
  }

  const rrule = obligationRRule(
    ob.frequency as ObligationFrequency,
    ob.due_day,
    ob.due_month
  );
  const today = (() => {
    const d = new Date(Date.now() + 330 * 60000);
    return { y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, d: d.getUTCDate() };
  })();
  const first = nextObligationDate(
    ob.frequency as ObligationFrequency,
    ob.due_day!,
    ob.due_month,
    today
  );
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
    .select("id, task_id, obligation_id")
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
          : null;
      if (outcome?.created) created += 1;
    } catch {
      // leave it pending for the next sweep
    }
  }
  return created;
}
