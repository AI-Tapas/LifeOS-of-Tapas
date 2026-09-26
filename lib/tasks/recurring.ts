// Recurring-task rule handling. V1 rule format is deliberately small:
//   "<freq>" or "<freq>:<interval>"  where freq is daily | weekly | monthly |
//   yearly and interval is a positive integer (default 1).
// Examples: "daily", "weekly:2" (fortnightly), "monthly", "yearly".
// Completing an occurrence advances the due timestamp by one interval, keeping
// the IST time-of-day. Documented in the README.

// Relative .ts import so node --test (type stripping, no bundler) can load
// this file, the same convention lib/tasks/triage.ts uses. M7b ports this
// rule to recurring obligations, and the port is an import, not a copy.
import {
  istCivil,
  istHour,
  istMinute,
  addDays,
  addMonths,
  civilKey,
  istInstant,
  startOfWeek,
} from "../datetime.ts";

export type RecurFreq = "daily" | "weekly" | "monthly" | "yearly";
export interface RecurRule {
  freq: RecurFreq;
  interval: number;
}

const FREQS: RecurFreq[] = ["daily", "weekly", "monthly", "yearly"];

export function parseRecurringRule(rule: string | null | undefined): RecurRule | null {
  if (!rule) return null;
  const [freqRaw, intervalRaw] = rule.trim().toLowerCase().split(":");
  const freq = FREQS.find((f) => f === freqRaw);
  if (!freq) return null;
  const interval = intervalRaw ? parseInt(intervalRaw, 10) : 1;
  if (!Number.isFinite(interval) || interval < 1) return null;
  return { freq, interval };
}

export function isValidRecurringRule(rule: string | null | undefined): boolean {
  return rule == null || rule === "" || parseRecurringRule(rule) !== null;
}

// Advance a due instant by one interval of the rule, preserving IST wall-clock
// time. Returns null when the rule is empty or invalid.
export function nextDueIso(
  rule: string | null | undefined,
  fromIso: string
): string | null {
  const parsed = parseRecurringRule(rule);
  if (!parsed) return null;
  const civ = istCivil(fromIso);
  const hour = istHour(fromIso);
  const minute = istMinute(fromIso);
  let next;
  switch (parsed.freq) {
    case "daily":
      next = addDays(civ, parsed.interval);
      break;
    case "weekly":
      next = addDays(civ, parsed.interval * 7);
      break;
    case "monthly":
      next = addMonths(civ, parsed.interval);
      break;
    case "yearly":
      next = addMonths(civ, parsed.interval * 12);
      break;
  }
  return istInstant(next, hour, minute).toISOString();
}

// B19. The start date of an occurrence: the first day of the calendar period
// its due date falls in (the day, the Monday-to-Sunday week, the month or the
// year of the rule's frequency). A freshly spawned occurrence gets this as
// not_before, so only the current occurrence is ever visible.
//
// For the monthly invoice that is exactly Tapas's rule: the occurrence due on
// 3 November covers October, can start once October ends, and waits until
// 1 November; the one due 3 October waits until 1 October. For a monthly
// rule this is also "the first day after the previous occurrence's period
// ends", since each occurrence's period is the month it falls due in.
// ponytail: the period is the calendar unit of the frequency, whatever the
// interval, so a "monthly:3" occurrence waits for the first of its own due
// month rather than for the start of a quarter. Add a quarter rule only if a
// quarterly task ever shows up too late to be useful.
export function periodStartKey(
  rule: string | null | undefined,
  dueIso: string
): string | null {
  const parsed = parseRecurringRule(rule);
  if (!parsed) return null;
  const civ = istCivil(dueIso);
  switch (parsed.freq) {
    case "daily":
      return civilKey(civ);
    case "weekly":
      return civilKey(startOfWeek(civ));
    case "monthly":
      return civilKey({ y: civ.y, m: civ.m, d: 1 });
    case "yearly":
      return civilKey({ y: civ.y, m: 1, d: 1 });
  }
}

// The next occurrence's two dates, as the spawner writes them: due one
// interval on, and waiting until the start of its own period. One function so
// the spawner and scripts/b19.test.ts cannot drift apart.
export function nextOccurrence(
  rule: string | null | undefined,
  fromIso: string
): { due_ts: string; not_before: string | null } | null {
  const due = nextDueIso(rule, fromIso);
  if (!due) return null;
  return { due_ts: due, not_before: periodStartKey(rule, due) };
}
