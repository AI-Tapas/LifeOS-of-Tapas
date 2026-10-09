// Which events belong to a window of time. An event belongs to [from, to] when
// it starts before the window ends AND is still running when the window
// starts: an all-day session spanning the 7th to the 9th is on the 8th's list
// even though it started on the 7th. Every "today" and "next 7 days" query
// must use this, because filtering on start_ts alone dropped exactly those
// events and the 8 October 2026 brief called a session day a rest day.
//
// All-day rows end at midnight exclusive (end_ts of 18:30Z is the next IST
// day's 00:00), so the comparison is strict: an event ending exactly when the
// window starts is not in it. A row with no end_ts counts only by its start.
//
import { istCivil } from "../datetime.ts";

// Usage: q.lte("start_ts", to).or(overlapsFrom(from))
export function overlapsFrom(from: string): string {
  return `end_ts.gt.${from},and(end_ts.is.null,start_ts.gte.${from})`;
}

// Whether a calendar's next sync must drop its provider cursor and fetch the
// whole window again. Google's syncToken and Graph's deltaLink remember the
// window of the first full fetch, so the 12-month horizon never moved and the
// 60-day tail never purged. The first sync of each IST month is a full one:
// no new column, and the horizon never shrinks below 11 months.
export function needsFullResync(
  syncToken: string | null,
  lastSyncedAt: string | null,
  nowMs: number = Date.now()
): boolean {
  if (!syncToken || !lastSyncedAt) return true;
  const last = istCivil(lastSyncedAt);
  const now = istCivil(new Date(nowMs));
  return last.y !== now.y || last.m !== now.m;
}
