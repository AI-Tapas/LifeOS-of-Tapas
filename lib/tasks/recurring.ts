// Recurring-task rule handling. V1 rule format is deliberately small:
//   "<freq>" or "<freq>:<interval>"  where freq is daily | weekly | monthly |
//   yearly and interval is a positive integer (default 1).
// Examples: "daily", "weekly:2" (fortnightly), "monthly", "yearly".
// Completing an occurrence advances the due timestamp by one interval, keeping
// the IST time-of-day. Documented in the README.

import {
  istCivil,
  istHour,
  istMinute,
  addDays,
  addMonths,
  istInstant,
} from "@/lib/datetime";

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
