// Pure reminder logic: offsets-to-overrides mapping, the recurrence rule for
// obligations, the Google reminder-event payload, the reminder-home guard and
// the cleanup orchestration. No server imports, so scripts/m3.test.ts can
// load this file directly under `node --test` type-stripping, exactly like
// lib/oauth/core.ts. The DB- and network-wired writer is lib/reminders/writer.ts.
//
// M7b added one import, the recurring-rule parser tasks have used since M1,
// because a sub-monthly obligation series must read the same rule a task
// does rather than a second one that drifts from it. Relative .ts, so the
// type-stripping loader still resolves it.

import { parseRecurringRule } from "../tasks/recurring.ts";

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

// Calendar title for a task's reminder. M6b renamed checklist steps to bare
// titles ("Book onward ticket") because the trip screen already says which
// trip you are looking at. Google Calendar does not, so a phone with three
// trips in flight showed three identical reminders. The trip name rides in
// the title when the task belongs to one.
export function reminderTitle(taskTitle: string, tripTitle?: string | null): string {
  const trip = tripTitle?.trim();
  return trip ? `Reminder: ${taskTitle} (${trip})` : `Reminder: ${taskTitle}`;
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
  | "custom"
  | "monthly"
  | "bi_monthly"
  | "quarterly"
  | "half_yearly"
  | "yearly";

// How many months one step of each frequency covers. 'custom' is absent
// because it is not a monthly family member at all: it counts in days.
export const OBLIGATION_MONTH_INTERVAL: Record<string, number> = {
  monthly: 1,
  bi_monthly: 2,
  quarterly: 3,
  half_yearly: 6,
  yearly: 12,
};

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
  if (frequency === "yearly") {
    if (!dueMonth || dueMonth < 1 || dueMonth > 12) {
      throw new Error("a yearly obligation needs a due month between 1 and 12");
    }
    return `RRULE:FREQ=YEARLY;BYMONTH=${dueMonth};BYMONTHDAY=${dueDay}`;
  }
  // 'yearly' returned above, so anything left without a month interval is
  // 'custom', which has its own rule and must not reach here.
  const interval = OBLIGATION_MONTH_INTERVAL[frequency];
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
// Sub-monthly obligation intervals (backlog B2)
// ---------------------------------------------------------------------------
// obligation_frequency ran monthly and longer, so a fortnightly payment could
// not be said at all: a due day of the month has no meaning every ten days.
// Frequency 'custom' fills the gap, and it reads the SAME rule tasks have
// used since M1 (lib/tasks/recurring.ts, "<freq>:<interval>"), restricted to
// daily and weekly because the monthly family is already in the enum.
//
// It needs an anchor as well as an interval. "Every ten days" is only a
// series once you say from when, and unlike a monthly obligation there is no
// day-of-month to derive it from.

export interface ObligationSeries {
  frequency: ObligationFrequency;
  due_day?: number | null;
  due_month?: number | null;
  interval_rule?: string | null; // 'daily:10', 'weekly:2'
  anchor_date?: string | null; // YYYY-MM-DD, the first occurrence
}

// How many days one step of a custom rule covers. Throws on anything the
// rule cannot mean, so a malformed row fails loudly at save time instead of
// quietly writing a reminder on the wrong day.
export function customStepDays(rule: string | null | undefined): number {
  const parsed = parseRecurringRule(rule);
  if (!parsed) throw new Error("a custom obligation needs a rule like 'weekly:2'");
  if (parsed.freq === "daily") return parsed.interval;
  if (parsed.freq === "weekly") return parsed.interval * 7;
  throw new Error(
    "a custom obligation counts in days or weeks; use the monthly frequencies for longer"
  );
}

export function parseDateKey(key: string | null | undefined): {
  y: number;
  m: number;
  d: number;
} {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec((key ?? "").trim());
  if (!m) throw new Error("a custom obligation needs a start date");
  return { y: Number(m[1]), m: Number(m[2]), d: Number(m[3]) };
}

export function civilDateKey(c: { y: number; m: number; d: number }): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${c.y}-${p(c.m)}-${p(c.d)}`;
}

function toEpochDay(c: { y: number; m: number; d: number }): number {
  return Math.floor(Date.UTC(c.y, c.m - 1, c.d) / 86400000);
}

function fromEpochDay(day: number): { y: number; m: number; d: number } {
  const dt = new Date(day * 86400000);
  return { y: dt.getUTCFullYear(), m: dt.getUTCMonth() + 1, d: dt.getUTCDate() };
}

// The RRULE for any obligation, custom included. One entry point, so the
// writer never has to know which family a row belongs to.
export function obligationSeriesRRule(series: ObligationSeries): string {
  if (series.frequency === "custom") {
    const step = customStepDays(series.interval_rule);
    const parsed = parseRecurringRule(series.interval_rule)!;
    const freq = parsed.freq === "weekly" ? "WEEKLY" : "DAILY";
    const interval = parsed.freq === "weekly" ? step / 7 : step;
    const intervalPart = interval === 1 ? "" : `;INTERVAL=${interval}`;
    return `RRULE:FREQ=${freq}${intervalPart}`;
  }
  return obligationRRule(series.frequency, series.due_day, series.due_month);
}

// The next `count` dates of the series, on or after `from`, as YYYY-MM-DD.
//
// This exists so the series is VISIBLE. A rule he cannot read is a rule he has
// to trust, and the whole point of B2 is that he can see the next three dates
// on the obligation itself and catch a wrong one before it reminds him.
// The first entry is also what the writer anchors the calendar event on, so
// what he reads and what Google expands are the same series by construction.
export function nextObligationDates(
  series: ObligationSeries,
  from: { y: number; m: number; d: number },
  count = 3
): string[] {
  if (count < 1) return [];

  if (series.frequency === "custom") {
    const step = customStepDays(series.interval_rule);
    const anchorDay = toEpochDay(parseDateKey(series.anchor_date));
    const fromDay = toEpochDay(from);
    // A series that started in the past is fast-forwarded in one step rather
    // than looped: an anchor five years back is otherwise hundreds of turns.
    const first =
      anchorDay >= fromDay
        ? anchorDay
        : anchorDay + Math.ceil((fromDay - anchorDay) / step) * step;
    return Array.from({ length: count }, (_, i) => civilDateKey(fromEpochDay(first + i * step)));
  }

  const dueDay = series.due_day;
  if (!dueDay || dueDay < 1 || dueDay > 31) {
    throw new Error("obligation reminder needs a due day between 1 and 31");
  }
  const first = nextObligationDate(series.frequency, dueDay, series.due_month, from);
  const stepMonths = OBLIGATION_MONTH_INTERVAL[series.frequency];
  if (!stepMonths) throw new Error(`unknown obligation frequency: ${series.frequency}`);

  const out: string[] = [];
  for (let i = 0; i < count; i++) {
    const total = (first.y * 12 + (first.m - 1)) + i * stepMonths;
    const y = Math.floor(total / 12);
    const m = (total % 12) + 1;
    // A 31st in a 30-day month falls back to the last day, exactly as
    // nextObligationDate clamps it.
    const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
    out.push(civilDateKey({ y, m, d: Math.min(dueDay, lastDay) }));
  }
  return out;
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

// ---------------------------------------------------------------------------
// M7a: which reminders reach the calendar at all
// ---------------------------------------------------------------------------
// The calendar is for interrupts. The app and the morning brief are for the
// list. A calendar reminder is an interruption aimed at his attention on a
// particular day, so it is kept for work where missing the date has a real
// consequence; routine admin is chased perfectly well by the Home ranking,
// the trip screen and the 7 AM brief.
//
// Nothing is hidden by 'in_app': the task keeps its due date, its place in
// the ranking, its line in the brief and its trip rollup. Only the Google
// Calendar event stops being written.
export type ReminderMode = "calendar" | "in_app";
export const REMINDER_MODES: ReminderMode[] = ["calendar", "in_app"];

export function isReminderMode(v: unknown): v is ReminderMode {
  return v === "calendar" || v === "in_app";
}

// What the writer should do with a task's reminder, as one decision instead
// of three conditions scattered through the writer. "remove" covers both
// directions, so switching a task from calendar to in_app deletes the event
// it already had by the same path that a completed task uses; there is no
// second cleanup route that could leave an orphan behind.
export interface TaskReminderState {
  reminder_mode?: ReminderMode | null;
  due_ts: string | null;
  status: string;
}

export function planTaskReminder(task: TaskReminderState): "write" | "remove" {
  // A null column is a row written before this milestone, which read as a
  // calendar reminder then and must keep reading as one now.
  const mode: ReminderMode = task.reminder_mode ?? "calendar";
  if (mode === "in_app") return "remove";
  if (!task.due_ts) return "remove";
  if (task.status === "done" || task.status === "dropped") return "remove";
  return "write";
}

// ---------------------------------------------------------------------------
// M7b: which reminder an investment gets
// ---------------------------------------------------------------------------
// Money is genuinely at stake on a maturity date. An FD that matures unnoticed
// rolls over at a worse rate, and that is precisely the interruption M7a
// reserved the calendar for, so a maturity writes one calendar event with the
// standard offsets.
//
// A review date is a date to think on, not a deadline. Nothing is lost by
// noticing it a day late, so it stays in the app: it ranks on Home and it
// appears in the morning brief, and it never interrupts him. Same rule as a
// task's reminder_mode, decided from what the date MEANS rather than from a
// separate column somebody would have to keep in step.
export type FinanceKeyDateType = "maturity" | "review";

export function isFinanceKeyDateType(v: unknown): v is FinanceKeyDateType {
  return v === "maturity" || v === "review";
}

export function financeReminderMode(
  keyDateType: FinanceKeyDateType | null | undefined
): ReminderMode {
  return keyDateType === "maturity" ? "calendar" : "in_app";
}

export interface FinanceReminderState {
  key_date: string | null;
  key_date_type: FinanceKeyDateType | null;
  remind: boolean;
}

export function planFinanceReminder(item: FinanceReminderState): "write" | "remove" {
  if (!item.remind) return "remove";
  if (!item.key_date) return "remove";
  if (financeReminderMode(item.key_date_type) === "in_app") return "remove";
  return "write";
}

// ---------------------------------------------------------------------------
// One trip, one calendar entry
// ---------------------------------------------------------------------------
// With the per-step events gone the calendar would lose sight of the travel
// itself, which he does want to see. A trip writes ONE all-day event spanning
// its dates, not one per step.

// Google reminder overrides on an all-day event count back from midnight at
// the start of the day. 900 minutes is 15 hours, which is 09:00 IST the day
// before: the same "the day before, in the morning" Google's own all-day
// default uses. One override, not the four-offset set a due date gets.
export const TRIP_REMINDER_MINUTES = 900;

export interface GoogleAllDayEvent {
  summary: string;
  description?: string;
  start: { date: string };
  end: { date: string }; // exclusive, per the Google Calendar API
  transparency: "transparent";
  reminders: { useDefault: false; overrides: ReminderOverride[] };
}

// The title he reads on the phone. The city is what identifies a trip, so it
// rides along unless the trip title already says it.
export function tripEventTitle(title: string, cities: string[]): string {
  const city = cities.find((c) => c && c.trim())?.trim();
  if (!city) return title;
  if (title.toLowerCase().includes(city.toLowerCase())) return title;
  return `${title} (${city})`;
}

// Google treats an all-day event's end date as exclusive, so a single-day
// trip ends on the following day and a three-day trip covers three squares
// rather than two.
export function nextDateKey(dateOnly: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateOnly);
  if (!m) throw new Error(`Invalid date: ${dateOnly}`);
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + 1));
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`;
}

export interface TripEventInput {
  title: string;
  cities: string[];
  startDate: string; // YYYY-MM-DD
  endDate?: string | null; // defaults to the start date
  description?: string;
}

export function buildTripEvent(input: TripEventInput): GoogleAllDayEvent {
  const end = input.endDate && input.endDate >= input.startDate
    ? input.endDate
    : input.startDate;
  const event: GoogleAllDayEvent = {
    summary: tripEventTitle(input.title, input.cities),
    start: { date: input.startDate },
    end: { date: nextDateKey(end) },
    // Travel does not block his working hours the way a meeting does, and the
    // reminder events already use this.
    transparency: "transparent",
    reminders: {
      useDefault: false,
      overrides: [{ method: "popup", minutes: TRIP_REMINDER_MINUTES }],
    },
  };
  if (input.description) event.description = input.description;
  return event;
}
