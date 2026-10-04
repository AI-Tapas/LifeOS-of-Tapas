// Calendar day placement and time-grid geometry (B33). Pure, so the calendar
// component and scripts/b33.test.ts share one implementation. Times are stored
// UTC and bucketed in IST through lib/datetime.

import {
  addDays,
  civilKey,
  formatDateIST,
  formatWeekdayIST,
  formatWeekdayLongIST,
  istDayKey,
  istInstant,
  startOfWeek,
  type CivilDate,
} from "../datetime.ts";

export interface PlaceableEvent {
  start_ts: string;
  end_ts: string | null;
  all_day: boolean;
}

export function keyToCivil(key: string): CivilDate {
  const [y, m, d] = key.split("-").map(Number);
  return { y, m, d };
}

const DAY_MS = 86400000;
const MINUTE_MS = 60000;

// The IST day keys an event is drawn on.
// - All-day: start to end, end exclusive (a one-day event is one cell).
// - Timed: only the day it starts, unless it lasts 24 hours or more. An
//   overnight train that leaves at 11:55 pm belongs to the day it leaves.
export function eventDayKeys(e: PlaceableEvent): string[] {
  const startKey = istDayKey(e.start_ts);
  if (!e.end_ts) return [startKey];
  const startMs = new Date(e.start_ts).getTime();
  const endMs = new Date(e.end_ts).getTime();
  if (!(endMs > startMs)) return [startKey];
  if (!e.all_day && endMs - startMs < DAY_MS) return [startKey];
  // Step back a minute so an end at exactly midnight does not claim that day.
  const endKey = istDayKey(new Date(endMs - MINUTE_MS).toISOString());
  const keys: string[] = [];
  let c = keyToCivil(startKey);
  for (let i = 0; i < 60; i++) {
    const k = civilKey(c);
    keys.push(k);
    if (k === endKey) break;
    c = addDays(c, 1);
  }
  return keys;
}

// ---------------------------------------------------------------------------
// Time grid geometry
// ---------------------------------------------------------------------------
export const GRID_START_HOUR = 7;
export const GRID_END_HOUR = 23; // the grid runs to 11 pm unless an event goes later
export const MIN_BLOCK_MINUTES = 30; // shortest block drawn, so a short event stays tappable

export interface Slice {
  id: string;
  startMin: number; // minutes after IST midnight of the day, 0..1440
  endMin: number;
}
export interface PlacedSlice extends Slice {
  col: number;
  cols: number;
}

// The part of a timed event that falls on one IST day, in minutes from that
// day's midnight. No end means one hour. Null when it does not touch the day.
export function sliceForDay(
  e: PlaceableEvent & { id: string },
  dayKey: string
): Slice | null {
  const dayStartMs = istInstant(keyToCivil(dayKey), 0, 0).getTime();
  const startMs = new Date(e.start_ts).getTime();
  const rawEnd = e.end_ts ? new Date(e.end_ts).getTime() : startMs + 60 * MINUTE_MS;
  const endMs = rawEnd > startMs ? rawEnd : startMs + MIN_BLOCK_MINUTES * MINUTE_MS;
  const startMin = Math.max(0, (startMs - dayStartMs) / MINUTE_MS);
  const endMin = Math.min(1440, (endMs - dayStartMs) / MINUTE_MS);
  if (endMin <= 0 || startMin >= 1440) return null;
  return { id: e.id, startMin, endMin: Math.max(endMin, startMin + 1) };
}

// Top and height in pixels for a slice, given the first hour shown.
export function blockBox(
  s: Slice,
  startHour: number,
  pxPerHour: number
): { top: number; height: number } {
  const top = ((s.startMin - startHour * 60) / 60) * pxPerHour;
  const minutes = Math.max(s.endMin - s.startMin, MIN_BLOCK_MINUTES);
  return { top, height: (minutes / 60) * pxPerHour };
}

// Side-by-side columns for overlapping slices. Slices that chain together
// through overlaps share one cluster and so one column count; a lone slice
// gets the full width.
export function layoutColumns(slices: Slice[]): PlacedSlice[] {
  const sorted = [...slices].sort(
    (a, b) => a.startMin - b.startMin || b.endMin - a.endMin || a.id.localeCompare(b.id)
  );
  const out: PlacedSlice[] = [];
  let cluster: PlacedSlice[] = [];
  let colEnds: number[] = []; // end minute of the last slice in each column
  let clusterEnd = -1;
  const flush = () => {
    for (const p of cluster) p.cols = colEnds.length;
    out.push(...cluster);
    cluster = [];
    colEnds = [];
    clusterEnd = -1;
  };
  for (const s of sorted) {
    const visibleEnd = Math.max(s.endMin, s.startMin + MIN_BLOCK_MINUTES);
    if (cluster.length && s.startMin >= clusterEnd) flush();
    let col = colEnds.findIndex((end) => end <= s.startMin);
    if (col === -1) col = colEnds.length;
    colEnds[col] = visibleEnd;
    clusterEnd = Math.max(clusterEnd, visibleEnd);
    cluster.push({ ...s, col, cols: 1 });
  }
  flush();
  return out;
}

// First and last hour the grid must show: 7 am to 11 pm, widened when an event
// sits outside that range.
export function gridHours(slices: Slice[]): { startHour: number; endHour: number } {
  let startHour = GRID_START_HOUR;
  let endHour = GRID_END_HOUR;
  for (const s of slices) {
    startHour = Math.min(startHour, Math.floor(s.startMin / 60));
    endHour = Math.max(endHour, Math.ceil(Math.max(s.endMin, s.startMin + MIN_BLOCK_MINUTES) / 60));
  }
  return { startHour: Math.max(0, startHour), endHour: Math.min(24, endHour) };
}

// ---------------------------------------------------------------------------
// Weekday labels
// ---------------------------------------------------------------------------
// "Friday, 23 October 2026"
export function dayHeading(dayKey: string): string {
  const at = istInstant(keyToCivil(dayKey), 12, 0);
  return `${formatWeekdayLongIST(at)}, ${formatDateIST(at)}`;
}

export interface WeekHead {
  key: string;
  weekday: string; // "Mon"
  day: number; // 5
  label: string; // "Mon 5"
  isToday: boolean;
}

// Monday to Sunday heads for the week containing anchorKey.
export function weekHeads(anchorKey: string, todayKey: string): WeekHead[] {
  const start = startOfWeek(keyToCivil(anchorKey));
  return Array.from({ length: 7 }, (_, i) => {
    const c = addDays(start, i);
    const key = civilKey(c);
    const weekday = formatWeekdayIST(istInstant(c, 12, 0));
    return { key, weekday, day: c.d, label: `${weekday} ${c.d}`, isToday: key === todayKey };
  });
}
