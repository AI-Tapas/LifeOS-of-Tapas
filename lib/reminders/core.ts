// Pure reminder logic: offsets-to-overrides mapping, the recurrence rule for
// obligations, the Google reminder-event payload, the reminder-home guard and
// the cleanup orchestration. Zero imports on purpose so scripts/m3.test.ts can
// load this file directly under `node --test` type-stripping, exactly like
// lib/oauth/core.ts. The DB- and network-wired writer is lib/reminders/writer.ts.

export const IST_TZ = "Asia/Kolkata";

// Google Calendar limits: at most 5 reminder overrides, each at most 28 days
// (40320 minutes) before the start.
export const MAX_OVERRIDES = 5;
export const MAX_OFFSET_DAYS = 28;

export type ReminderMethod = "popup" | "email";
export interface ReminderOverride {
  method: ReminderMethod;
  minutes: number;
}

// remind_offsets are stored in DAYS on the source row (default {7,3,1,0}).
// Map them to Google's minute overrides: 7 days -> 10080, 3 -> 4320, 1 -> 1440,
// 0 -> 0. Invalid values are dropped, duplicates removed, the result sorted
// earliest-notice-first and capped at five (Google's maximum).
export function offsetsDaysToMinutes(days: number[]): number[] {
  const valid = days.filter(
    (d) => Number.isInteger(d) && d >= 0 && d <= MAX_OFFSET_DAYS
  );
  const unique = Array.from(new Set(valid));
  unique.sort((a, b) => b - a); // largest offset (earliest reminder) first
  return unique.slice(0, MAX_OVERRIDES).map((d) => d * 1440);
}

export function buildReminderOverrides(
  days: number[],
  method: ReminderMethod = "popup"
): ReminderOverride[] {
  return offsetsDaysToMinutes(days).map((minutes) => ({ method, minutes }));
}

// A single Google Calendar event carrying all reminder overrides. One event,
// never one-per-offset. A recurring obligation passes an rrule; a task due date
// passes none.
export interface ReminderEventInput {
  title: string;
  description?: string;
  startDateTime: string; // RFC3339, IST offset for correct recurrence expansion
  endDateTime: string;
  timeZone?: string;
  offsetsDays: number[];
  rrule?: string; // e.g. "RRULE:FREQ=MONTHLY;BYMONTHDAY=15"
}

export interface GoogleReminderEvent {
  summary: string;
  description?: string;
  start: { dateTime: string; timeZone: string };
  end: { dateTime: string; timeZone: string };
  recurrence?: string[];
  transparency: "transparent";
  reminders: { useDefault: false; overrides: ReminderOverride[] };
}

export function buildGoogleReminderEvent(
  input: ReminderEventInput
): GoogleReminderEvent {
  const tz = input.timeZone ?? IST_TZ;
  const event: GoogleReminderEvent = {
    summary: input.title,
    start: { dateTime: input.startDateTime, timeZone: tz },
    end: { dateTime: input.endDateTime, timeZone: tz },
    transparency: "transparent", // a reminder should not show the user as busy
    reminders: {
      useDefault: false,
      overrides: buildReminderOverrides(input.offsetsDays),
    },
  };
  if (input.description) event.description = input.description;
  if (input.rrule) event.recurrence = [input.rrule];
  return event;
}

// ---------------------------------------------------------------------------
// Obligation recurrence
// ---------------------------------------------------------------------------
export type ObligationFrequency =
  | "monthly"
  | "bi_monthly"
  | "quarterly"
  | "half_yearly"
  | "yearly";

// Map an obligation's frequency + due day (+ due month for yearly) to a single
// RRULE. Monthly-family frequencies vary only by INTERVAL.
export function obligationRRule(
  frequency: ObligationFrequency,
  dueDay: number | null | undefined,
  dueMonth: number | null | undefined
): string {
  if (!dueDay || dueDay < 1 || dueDay > 31) {
    throw new Error("obligation reminder needs a due day between 1 and 31");
  }
  const monthlyInterval: Record<string, number> = {
    monthly: 1,
    bi_monthly: 2,
    quarterly: 3,
    half_yearly: 6,
  };
  if (frequency === "yearly") {
    if (!dueMonth || dueMonth < 1 || dueMonth > 12) {
      throw new Error("a yearly obligation needs a due month between 1 and 12");
    }
    return `RRULE:FREQ=YEARLY;BYMONTH=${dueMonth};BYMONTHDAY=${dueDay}`;
  }
  const interval = monthlyInterval[frequency];
  if (!interval) throw new Error(`unknown obligation frequency: ${frequency}`);
  const intervalPart = interval === 1 ? "" : `;INTERVAL=${interval}`;
  return `RRULE:FREQ=MONTHLY${intervalPart};BYMONTHDAY=${dueDay}`;
}

// Next calendar date (UTC ints) on or after `from` that matches due day/month.
// Used to anchor the recurring reminder event's first occurrence. Kept as plain
// integer maths to keep this module import-free.
export function nextObligationDate(
  frequency: ObligationFrequency,
  dueDay: number,
  dueMonth: number | null | undefined,
  from: { y: number; m: number; d: number }
): { y: number; m: number; d: number } {
  const clampDay = (y: number, m: number) =>
    Math.min(dueDay, new Date(Date.UTC(y, m, 0)).getUTCDate());

  if (frequency === "yearly") {
    const mm = dueMonth ?? 1;
    let y = from.y;
    // If this year's date has passed, roll to next year.
    const thisYearDay = clampDay(y, mm);
    if (from.m > mm || (from.m === mm && from.d > thisYearDay)) y += 1;
    return { y, m: mm, d: clampDay(y, mm) };
  }
  // Monthly family: find the next month whose date is not in the past.
  let y = from.y;
  let m = from.m; // 1-12
  for (let i = 0; i < 24; i++) {
    const d = clampDay(y, m);
    if (y > from.y || (y === from.y && (m > from.m || (m === from.m && d >= from.d)))) {
      return { y, m, d };
    }
    m += 1;
    if (m > 12) {
      m = 1;
      y += 1;
    }
  }
  return { y: from.y, m: from.m, d: clampDay(from.y, from.m) };
}

// ---------------------------------------------------------------------------
// Reminder-home guard (structural rule: reminders target ONLY the reminder-home
// calendar). Both the writer and the test call this.
// ---------------------------------------------------------------------------
export interface HomeCalendar {
  id: string;
  account_id: string;
  is_reminder_home: boolean;
}

export function assertReminderHome(
  cal: HomeCalendar | null | undefined
): asserts cal is HomeCalendar {
  if (!cal) throw new Error("no reminder-home calendar is configured");
  if (!cal.is_reminder_home) {
    throw new Error(
      "reminder events may only be written to the reminder-home calendar"
    );
  }
}

// ---------------------------------------------------------------------------
// Cleanup orchestration (injected deps, pure) so completion / drop / delete are
// unit-tested offline, in the style of resourceWithReauth. Every reminder row
// that has an ext_event_id gets that Google event deleted before the row is
// removed, so no orphan events are left behind.
// ---------------------------------------------------------------------------
export interface ReminderRowRef {
  id: string;
  ext_event_id: string | null;
}

export interface ReminderCleanupDeps {
  load: () => Promise<ReminderRowRef[]>;
  deleteEvent: (extEventId: string) => Promise<void>;
  deleteRow: (reminderId: string) => Promise<void>;
}

export async function runReminderCleanup(
  deps: ReminderCleanupDeps
): Promise<{ deletedEvents: number; deletedRows: number }> {
  const rows = await deps.load();
  let deletedEvents = 0;
  let deletedRows = 0;
  for (const row of rows) {
    if (row.ext_event_id) {
      await deps.deleteEvent(row.ext_event_id);
      deletedEvents += 1;
    }
    await deps.deleteRow(row.id);
    deletedRows += 1;
  }
  return { deletedEvents, deletedRows };
}
