// Offline proof for B33: calendar view fixes. Run: npm run test:b33
// (Node 22.18+, native TS type stripping). No network, no database: the sync
// runs the real lib/events/sync.ts against an in-memory stand-in
// (b33-sync-loader.mjs, b33-sync-stubs.ts). Synthetic data only.

import { register } from "node:module";
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { reset, world } from "./b33-sync-stubs.ts";
import {
  blockBox,
  dayHeading,
  eventDayKeys,
  gridHours,
  layoutColumns,
  sliceForDay,
  weekHeads,
} from "../lib/calendar/grid.ts";
import { istInstant } from "../lib/datetime.ts";

register("./b33-sync-loader.mjs", import.meta.url);
const { syncAllEvents } = await import("../lib/events/sync.ts");

// IST wall clock to an ISO instant.
const at = (y: number, m: number, d: number, hh = 0, mm = 0) =>
  istInstant({ y, m, d }, hh, mm).toISOString();
const timed = (start: string, end: string | null) => ({ start_ts: start, end_ts: end, all_day: false });

// ---------------------------------------------------------------------------
// Day placement
// ---------------------------------------------------------------------------
test("a 23:55 start plus 60 minutes stays on the 23rd", () => {
  assert.deepEqual(eventDayKeys(timed(at(2026, 10, 23, 23, 55), at(2026, 10, 24, 0, 55))), ["2026-10-23"]);
});

test("10:00 to 18:00 is one day", () => {
  assert.deepEqual(eventDayKeys(timed(at(2026, 10, 23, 10), at(2026, 10, 23, 18))), ["2026-10-23"]);
});

test("a timed event with no end, or an end before its start, is one day", () => {
  assert.deepEqual(eventDayKeys(timed(at(2026, 10, 23, 10), null)), ["2026-10-23"]);
  assert.deepEqual(eventDayKeys(timed(at(2026, 10, 23, 10), at(2026, 10, 22, 9))), ["2026-10-23"]);
});

test("a 26-hour timed event spans two days; exactly 24 hours also does", () => {
  assert.deepEqual(eventDayKeys(timed(at(2026, 10, 23, 10), at(2026, 10, 24, 12))), ["2026-10-23", "2026-10-24"]);
  assert.deepEqual(eventDayKeys(timed(at(2026, 10, 23, 10), at(2026, 10, 24, 10))), ["2026-10-23", "2026-10-24"]);
});

test("an all-day event from the 6th to the 8th (end exclusive) spans the 6th and 7th", () => {
  const e = { start_ts: at(2026, 10, 6), end_ts: at(2026, 10, 8), all_day: true };
  assert.deepEqual(eventDayKeys(e), ["2026-10-06", "2026-10-07"]);
  const one = { start_ts: at(2026, 10, 6), end_ts: at(2026, 10, 7), all_day: true };
  assert.deepEqual(eventDayKeys(one), ["2026-10-06"]);
});

// ---------------------------------------------------------------------------
// Grid geometry
// ---------------------------------------------------------------------------
test("10:00 to 18:00 is an 8-hour block, placed from the first hour shown", () => {
  const s = sliceForDay({ id: "a", ...timed(at(2026, 10, 23, 10), at(2026, 10, 23, 18)) }, "2026-10-23")!;
  assert.equal(s.startMin, 600);
  assert.equal(s.endMin, 1080);
  const box = blockBox(s, 7, 48);
  assert.equal(box.top, 3 * 48);
  assert.equal(box.height, 8 * 48);
});

test("a late-night event is clipped at midnight and keeps a visible height", () => {
  const s = sliceForDay({ id: "t", ...timed(at(2026, 10, 23, 23, 55), at(2026, 10, 24, 0, 55)) }, "2026-10-23")!;
  assert.equal(s.endMin, 1440);
  assert.ok(blockBox(s, 7, 48).height >= 24, "short slices are drawn at least half an hour tall");
  assert.deepEqual(gridHours([s]), { startHour: 7, endHour: 24 });
});

test("a 26-hour event is drawn on both days, clipped to each", () => {
  const e = { id: "x", ...timed(at(2026, 10, 23, 22), at(2026, 10, 24, 12)) };
  const a = sliceForDay(e, "2026-10-23")!;
  const b = sliceForDay(e, "2026-10-24")!;
  assert.deepEqual([a.startMin, a.endMin], [1320, 1440]);
  assert.deepEqual([b.startMin, b.endMin], [0, 720]);
  assert.equal(sliceForDay(e, "2026-10-25"), null);
});

test("overlapping events sit side by side; separate ones keep the full width", () => {
  const p = layoutColumns([
    { id: "a", startMin: 600, endMin: 720 },
    { id: "b", startMin: 660, endMin: 780 },
    { id: "c", startMin: 725, endMin: 770 },
    { id: "d", startMin: 900, endMin: 960 },
  ]);
  const by = Object.fromEntries(p.map((x) => [x.id, x]));
  assert.equal(by.a.col, 0);
  assert.equal(by.b.col, 1);
  assert.equal(by.c.col, 0, "c reuses a's column once a has ended");
  assert.deepEqual([by.a.cols, by.b.cols, by.c.cols], [2, 2, 2]);
  assert.deepEqual([by.d.col, by.d.cols], [0, 1]);
});

// ---------------------------------------------------------------------------
// Weekday labels
// ---------------------------------------------------------------------------
test("23 October 2026 is a Friday and the day heading says so", () => {
  assert.equal(dayHeading("2026-10-23"), "Friday, 23 October 2026");
});

test("week heads run Monday to Sunday and mark today", () => {
  const heads = weekHeads("2026-10-07", "2026-10-06");
  assert.deepEqual(heads.map((h) => h.label), ["Mon 5", "Tue 6", "Wed 7", "Thu 8", "Fri 9", "Sat 10", "Sun 11"]);
  assert.deepEqual(heads.filter((h) => h.isToday).map((h) => h.label), ["Tue 6"]);
});

// ---------------------------------------------------------------------------
// Sync: the family travel calendar is never read, and its copies are removed
// ---------------------------------------------------------------------------
const USER = "user-1";
function seed() {
  reset();
  world.tables = {
    accounts: [{ id: "a1", user_id: USER, slot: "ca_tapasnr", provider: "google", status: "connected" }],
    calendars: [
      { id: "c-main", account_id: "a1", ext_calendar_id: "main", sync_token: null, sync_enabled: true, is_family_travel: null },
      { id: "c-fam", account_id: "a1", ext_calendar_id: "family", sync_token: null, sync_enabled: true, is_family_travel: true },
    ],
    events: [
      { id: "e1", calendar_id: "c-main", ext_event_id: "m1", source: "synced", title: "Own" },
      { id: "e2", calendar_id: "c-fam", ext_event_id: "f1", source: "synced", title: "Flight Ahmedabad to Bengaluru" },
      { id: "e3", calendar_id: "c-fam", ext_event_id: "f2", source: "synced", title: "In Bengaluru (full day)" },
    ],
  };
  globalThis.fetch = (async (url: string) => {
    world.fetched.push(String(url));
    return Response.json({
      items: [
        {
          id: "m1",
          summary: "Own",
          start: { dateTime: "2026-10-23T05:00:00Z" },
          end: { dateTime: "2026-10-23T06:00:00Z" },
        },
      ],
      nextSyncToken: "tok",
    });
  }) as typeof fetch;
}

test("the family calendar is skipped and its synced copies are removed", async () => {
  seed();
  const r = await syncAllEvents(USER);
  assert.equal(r[0].error, undefined);
  assert.equal(world.fetched.length, 1, "only the main calendar is read");
  assert.ok(world.fetched[0].includes("/calendars/main/"));
  assert.ok(!world.fetched.some((u) => u.includes("family")));
  assert.deepEqual(world.tables.events.map((e) => e.id), ["e1"], "the family rows are gone, the other calendar's row stays");
  const fam = world.tables.calendars.find((c) => c.id === "c-fam")!;
  assert.equal(fam.sync_token, null, "the family calendar was not marked as synced");
});

test("a family calendar with sync turned off is still purged; a disabled normal one is only skipped", async () => {
  seed();
  world.tables.calendars[1].sync_enabled = false;
  world.tables.calendars.push({ id: "c-off", account_id: "a1", ext_calendar_id: "off", sync_token: null, sync_enabled: false, is_family_travel: null });
  world.tables.events.push({ id: "e4", calendar_id: "c-off", ext_event_id: "o1", source: "synced", title: "Kept" });
  await syncAllEvents(USER);
  assert.deepEqual(world.tables.events.map((e) => e.id).sort(), ["e1", "e4"]);
  assert.ok(!world.fetched.some((u) => u.includes("/off/") || u.includes("family")));
});

test("with no family calendar chosen, nothing is purged and every calendar syncs", async () => {
  seed();
  world.tables.calendars[1].is_family_travel = null;
  await syncAllEvents(USER);
  assert.equal(world.fetched.length, 2);
  assert.ok(world.fetched.some((u) => u.includes("/calendars/family/")), "an ordinary calendar is read");
});

// ---------------------------------------------------------------------------
// Static checks: the choose action purges too, and B29 never reads events
// ---------------------------------------------------------------------------
test("setFamilyTravelCalendarAction deletes the synced copies of the chosen calendar", () => {
  const src = readFileSync(new URL("../app/(app)/settings/actions.ts", import.meta.url), "utf8");
  const fn = src.slice(src.indexOf("export async function setFamilyTravelCalendarAction"));
  const body = fn.slice(0, fn.indexOf("\nexport async function", 10));
  assert.match(body, /\.from\("events"\)\s*\.delete\(\)\s*\.eq\("calendar_id", target\.id\)\s*\.eq\("source", "synced"\)/);
});

test("the B29 sync never reads or writes the events table", () => {
  for (const f of ["sync.ts", "travel.ts"]) {
    const src = readFileSync(new URL(`../lib/family/${f}`, import.meta.url), "utf8");
    assert.ok(!/from\(\s*"events"\s*\)/.test(src), f);
  }
});
