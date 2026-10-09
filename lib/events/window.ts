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
// Usage: q.lte("start_ts", to).or(overlapsFrom(from))
export function overlapsFrom(from: string): string {
  return `end_ts.gt.${from},and(end_ts.is.null,start_ts.gte.${from})`;
}
