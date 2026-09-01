// How a recurring obligation reads on the screen: what its frequency is
// called in plain words, when it falls due, and the next three dates of its
// series. Pure, so scripts/m7b.test.ts proves the series he is actually shown
// rather than a paraphrase of it.
//
// The dates come from nextObligationDates, which is also what the reminder
// writer anchors the Google Calendar event on. One function, so what he reads
// and what Google expands cannot drift apart, which is the whole point of
// showing the series at all (backlog B2).
import { formatDateShortIST } from "../datetime.ts";
import { nextObligationDates, parseDateKey } from "../reminders/core.ts";

export type ObligationFrequency =
  | "custom"
  | "monthly"
  | "bi_monthly"
  | "quarterly"
  | "half_yearly"
  | "yearly";

export interface ObligationSeriesFields {
  active: boolean;
  frequency: ObligationFrequency;
  due_day: number | null;
  due_month: number | null;
  interval_rule: string | null;
  anchor_date: string | null;
}

const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

export function underscoresToWords(s: string): string {
  return s.replace(/_/g, " ");
}

// "custom" is a word for the database, not for him: the card says what the
// series actually does.
export function frequencyLabel(o: ObligationSeriesFields): string {
  if (o.frequency !== "custom") return underscoresToWords(o.frequency);
  const [freq, every] = (o.interval_rule ?? "").split(":");
  const n = Number(every || 1);
  const unit = freq === "daily" ? "day" : "week";
  return n === 1 ? `every ${unit}` : `every ${n} ${unit}s`;
}

// When in the cycle it falls. A custom series says it with its dates instead,
// so this returns nothing for one unless the start date is missing.
export function dueLabel(o: ObligationSeriesFields): string {
  if (o.frequency === "custom") return o.anchor_date ? "" : "no start date";
  if (!o.due_day) return "no due day";
  if (o.frequency === "yearly") {
    return `${o.due_day} ${o.due_month ? MONTHS[o.due_month - 1] : ""}`.trim();
  }
  return `day ${o.due_day}`;
}

// The next three dates, in his own date style. A rule he cannot read is a
// rule he has to trust; these are what let him catch a wrong one before it
// reminds him.
export function seriesDates(
  o: ObligationSeriesFields,
  todayKey: string,
  count = 3
): string[] {
  if (!o.active) return [];
  try {
    const thisYear = parseDateKey(todayKey).y;
    return nextObligationDates(o, parseDateKey(todayKey), count).map((k) => {
      const label = formatDateShortIST(`${k}T12:00:00+05:30`);
      // A yearly series is three dates a year apart, and "15 Apr, 15 Apr,
      // 15 Apr" reads as a bug. The year rides along whenever it is not the
      // current one, and stays out of the way when it is.
      return parseDateKey(k).y === thisYear ? label : `${label} ${parseDateKey(k).y}`;
    });
  } catch {
    // An incomplete row (no due day yet, no start date yet) simply shows no
    // series. Saving it is what surfaces the error message.
    return [];
  }
}
