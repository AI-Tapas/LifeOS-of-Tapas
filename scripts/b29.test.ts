// Offline proof for B29: the family travel calendar. Run: npm run test:b29
// (Node 22.18+, native TS type stripping). No network, no database, no Google:
// the calendar is an in-memory stand-in, and the leg tools run through the real
// executor and the real lib/trips/write.ts against the b26 in-memory database
// (b28-loader.mjs, b28-stubs.ts). Synthetic data only.
//
// What is proven:
//   1. The 6 to 9 October journey becomes exactly three "In <city> (full day)"
//      events and one event per leg, and none of it leaks a title, note,
//      stream, label, PNR, amount, hotel word or organisation name.
//   2. The sync is idempotent, touches only what it recorded, and cleans up.
//   3. Leg time validation on both tools and the ticket proposal.
//   4. The migration, the Settings action and the tool surface are shaped right.

import { register } from "node:module";
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  FORBIDDEN_WORDS,
  desiredFamilyEvents,
  familyPatchBody,
  legEvent,
  planFamilySync,
  runFamilySync,
  type FamilyEventPayload,
  type FamilyIO,
  type FamilyTrip,
  type RecordedEvent,
} from "../lib/family/travel.ts";
import { checkLegTime, parseLegs } from "../lib/trips/core.ts";
import { safePlace } from "../lib/family/travel.ts";
import { editLeg } from "../lib/trips/legs.ts";
import { validateTripLegProposals } from "../lib/trips/ticket.ts";
import { TOOLS, TICKET_TOOL, toolByName } from "../lib/assistant/tools.ts";
import { db, resetDb } from "./b26-stubs.ts";

register("./b28-loader.mjs", import.meta.url);
const { executeToolCall, undoExecutedAction } = await import("../lib/assistant/execute.ts");

const src = (rel: string) => readFileSync(new URL("../" + rel, import.meta.url), "utf8");
const USER = "user-1";
const TODAY = "2026-10-01";

// ---------------------------------------------------------------------------
// The journey: Bengaluru (Cygnet, 7 Oct), Delhi (Cygnet, 8 Oct), Surat (AICA,
// 9 Oct). Everything private is on the rows on purpose: titles, notes, stream,
// session label, PNRs, costs, hotel talk. None of it may reach the calendar.
// ---------------------------------------------------------------------------
const PRIVATE_BITS = [
  "Cygnet Bengaluru batch",
  "Cygnet Delhi batch",
  "AICA Surat Level 1",
  "Taj West End confirmed by the branch",
  "ICAI Surat branch",
  "L1D2",
  "PNR-AB12CD",
  "PNR-ZZ99YY",
  "5400",
  "7250",
  "Cygnet",
  "Hotel",
];

function journey(): (FamilyTrip & Record<string, unknown>)[] {
  const common = { user_id: USER, notes: "Hotel Taj West End booked, ICAI branch pays", session_label: "L1D2", work_stream: "Cygnet", purpose: "training" };
  return [
    {
      ...common,
      id: "t-blr",
      title: "Cygnet Bengaluru batch",
      status: "booked",
      session_date: "2026-10-07",
      cities: ["Ahmedabad", "Bengaluru"],
      legs: [
        { from: "Ahmedabad", to: "Bengaluru", date: "2026-10-06", mode: "flight", cost: 5400, ref: "PNR-AB12CD", time: "07:05" },
        { from: "Bengaluru", to: "Delhi", date: "2026-10-07", mode: "flight", cost: 7250, ref: "PNR-ZZ99YY", time: "19:00" },
      ],
    },
    {
      ...common,
      id: "t-del",
      title: "Cygnet Delhi batch",
      status: "booked",
      session_date: "2026-10-08",
      cities: ["Delhi"],
      legs: [{ from: "Delhi", to: "Surat", date: "2026-10-08", mode: "flight", cost: null }],
    },
    {
      ...common,
      id: "t-srt",
      title: "AICA Surat Level 1",
      status: "planned",
      session_date: "2026-10-09",
      purpose: "aica",
      cities: ["Surat"],
      legs: [
        { from: "Surat", to: "Ahmedabad (Ambli Road)", date: "2026-10-09", mode: "vande_bharat", cost: 900, time: "18:30" },
        { from: "Surat Airport", to: "Surat", date: "2026-10-09", mode: "cab", cost: 300, time: "09:15" },
      ],
    },
  ];
}

const titles = (trips: FamilyTrip[], today = TODAY) => desiredFamilyEvents(trips, today).map((e) => e.payload.summary).sort();

// --- 1. what is written ---------------------------------------------------------

test("the 6 to 9 October journey gives three session days and one event per leg, with the right titles", () => {
  const events = desiredFamilyEvents(journey(), TODAY);
  const sessions = events.filter((e) => e.kind === "session");
  const legs = events.filter((e) => e.kind === "leg");
  assert.deepEqual(
    sessions.map((e) => e.payload.summary).sort(),
    ["In Bengaluru (full day)", "In Delhi (full day)", "In Surat (full day)"]
  );
  assert.deepEqual(
    sessions.map((e) => (e.payload.start as { date: string }).date).sort(),
    ["2026-10-07", "2026-10-08", "2026-10-09"]
  );
  assert.equal(legs.length, 5);
  assert.deepEqual(titles(journey()).filter((t) => !t.startsWith("In ")), [
    "Cab Surat Airport to Surat",
    "Flight Ahmedabad to Bengaluru",
    "Flight Bengaluru to Delhi",
    "Flight Delhi to Surat (time to be confirmed)",
    "Train Surat to Ahmedabad (Ambli Road)",
  ]);
});

test("a timed leg starts at its time, flights run 120 minutes and the rest 60", () => {
  const by = (s: string) => events().find((e) => e.payload.summary === s)!.payload;
  const events = () => desiredFamilyEvents(journey(), TODAY);
  const flight = by("Flight Ahmedabad to Bengaluru");
  assert.deepEqual(flight.start, { dateTime: "2026-10-06T07:05:00+05:30", timeZone: "Asia/Kolkata" });
  assert.deepEqual(flight.end, { dateTime: "2026-10-06T09:05:00+05:30", timeZone: "Asia/Kolkata" });
  const train = by("Train Surat to Ahmedabad (Ambli Road)");
  assert.deepEqual(train.start, { dateTime: "2026-10-09T18:30:00+05:30", timeZone: "Asia/Kolkata" });
  assert.deepEqual(train.end, { dateTime: "2026-10-09T19:30:00+05:30", timeZone: "Asia/Kolkata" });
  // Over midnight: 23:30 plus 120 minutes is 01:30 the next day.
  const late = legEvent({ from: "Delhi", to: "Mumbai", date: "2026-10-09", mode: "flight", cost: null, time: "23:30" })!;
  assert.deepEqual(late.end, { dateTime: "2026-10-10T01:30:00+05:30", timeZone: "Asia/Kolkata" });
});

test("a leg with no time is an all-day event that says the time is to be confirmed", () => {
  const p = by_summary("Flight Delhi to Surat (time to be confirmed)");
  assert.deepEqual(p.start, { date: "2026-10-08" });
  assert.deepEqual(p.end, { date: "2026-10-09" });
  assert.equal(p.transparency, "transparent");
});

function by_summary(s: string): FamilyEventPayload {
  return desiredFamilyEvents(journey(), TODAY).find((e) => e.payload.summary === s)!.payload;
}

test("mode words: every train becomes Train, a cab Cab, a flight Flight, anything else Travel", () => {
  const word = (mode: string) =>
    legEvent({ from: "A", to: "B", date: "2026-10-09", mode: mode as never, cost: null, time: "10:00" })!.summary.split(" ")[0];
  assert.deepEqual(["vande_bharat", "tejas", "ac_sleeper", "cab", "flight", "other"].map(word), [
    "Train", "Train", "Train", "Cab", "Flight", "Travel",
  ]);
});

test("PRIVACY: no event carries a title, note, stream, label, PNR, amount, hotel or organisation word", () => {
  const events = desiredFamilyEvents(journey(), TODAY);
  assert.equal(events.length, 8);
  for (const e of events) {
    const text = JSON.stringify(e.payload).toLowerCase();
    for (const bit of PRIVATE_BITS) assert.ok(!text.includes(bit.toLowerCase()), `"${bit}" leaked into ${e.payload.summary}`);
    for (const w of FORBIDDEN_WORDS) assert.ok(!text.includes(w), `${w} leaked`);
    // Only these keys, nothing that could carry more.
    assert.deepEqual(
      Object.keys(e.payload).sort().filter((k) => k !== "transparency"),
      ["end", "reminders", "start", "summary"]
    );
    assert.equal("description" in e.payload, false);
    assert.equal("location" in e.payload, false);
    assert.equal("attendees" in e.payload, false);
    assert.equal("visibility" in e.payload, false, "visibility stays at the default");
    assert.deepEqual(e.payload.reminders, { useDefault: false, overrides: [] });
    if ("date" in e.payload.start) assert.equal(e.payload.transparency, "transparent");
  }
});

test("PRIVACY: a place name that is itself an organisation or hotel word is withheld, not printed", () => {
  const trips = journey();
  trips[0].legs = [
    { from: "Ahmedabad", to: "Cygnet Campus Bengaluru", date: "2026-10-06", mode: "cab", cost: null, time: "10:00" },
    { from: "Delhi", to: "Hotel Taj, Delhi", date: "2026-10-06", mode: "cab", cost: null },
    { from: "Delhi", to: "Surat", date: "2026-10-06", mode: "flight", cost: null, time: "10:00" },
  ];
  trips[0].cities = ["ICAI Bengaluru"];
  const all = titles(trips);
  assert.ok(!all.some((t) => /cygnet|hotel|icai/i.test(t)));
  assert.ok(all.includes("Flight Delhi to Surat"));
  assert.ok(!all.includes("In ICAI Bengaluru (full day)"), "a city that carries an organisation is not announced");
});

// --- place names are free text: safe by construction ----------------------------

test("PLACES: every forbidden word and a work stream name is refused, in any case, anywhere in the text", () => {
  for (const w of FORBIDDEN_WORDS) {
    assert.equal(safePlace(`Near ${w.toUpperCase()}`), null, w);
    assert.equal(safePlace(`${w}ville`), null, w);
  }
  for (const w of ["inn", "resort", "residency", "suites", "marriott", "taj", "itc", "novotel", "hyatt", "lemon tree", "ginger", "fortune", "radisson", "oyo", "office", "bhavan", "institute", "chapter", "branch", "client", "guest house"]) {
    assert.ok((FORBIDDEN_WORDS as readonly string[]).includes(w), `${w} is on the list`);
  }
  assert.equal(safePlace("Surat"), "Surat");
  assert.equal(safePlace("Acme Training Surat", ["Acme Training"]), null, "a work stream name");
  assert.equal(safePlace("Surat", ["Acme"]), "Surat");
});

test("PLACES: a digit withholds the place", () => {
  for (const p of ["Sector 5", "Surat 395007", "Gate2", "Flat 4B"]) assert.equal(safePlace(p), null, p);
});

test("PLACES: more than three words is withheld, three is fine", () => {
  assert.equal(safePlace("Mumbai Chhatrapati Shivaji Airport"), null);
  assert.equal(safePlace("Surat Railway Station"), "Surat Railway Station");
});

test("PLACES: everything after a comma or an opening bracket goes, a short round bracket stays", () => {
  assert.equal(safePlace("Delhi, near the guest list"), "Delhi");
  assert.equal(safePlace("Surat [private note"), "Surat");
  assert.equal(safePlace("Surat {x}"), "Surat");
  assert.equal(safePlace("Ahmedabad (Ambli Road)"), "Ahmedabad (Ambli Road)");
  assert.equal(safePlace("Ahmedabad (Kalupur)"), "Ahmedabad (Kalupur)");
  assert.equal(safePlace("Surat (Platform for the big boss)"), "Surat", "a long bracket is dropped");
  assert.equal(safePlace("Surat (Ambli, Road)"), "Surat", "a comma ends it before the bracket closes");
  assert.equal(safePlace("Surat (door 9)"), null, "digits withhold");
  assert.equal(safePlace("Surat (Ambli"), "Surat", "an unclosed bracket is dropped");
  assert.equal(safePlace(""), null);
});

test("PLACES: a withheld place becomes travel wording, never the place", () => {
  const leg = (from: string, to: string) => legEvent({ from, to, date: "2026-10-09", mode: "flight", cost: null, time: "10:00" }, ["Acme Training"])!.summary;
  assert.equal(leg("Hotel Taj, Delhi", "Surat"), "Flight to Surat");
  assert.equal(leg("Delhi", "Marriott Surat"), "Flight from Delhi");
  assert.equal(leg("Acme Training Park", "ICAI Bhavan"), "Flight");
  assert.equal(leg("Delhi, Terminal", "Surat"), "Flight Delhi to Surat");
  // A session city that is withheld writes no session event at all.
  const t = { ...journey()[0], cities: ["Grand Residency"] };
  assert.equal(desiredFamilyEvents([t], TODAY).filter((e) => e.kind === "session").length, 0);
  // Work stream names reach the whole desired set.
  const named = desiredFamilyEvents([{ ...journey()[0], cities: ["Acme Training City"] }], TODAY, ["Acme Training"]);
  assert.equal(named.filter((e) => e.kind === "session").length, 0);
});

test("the home city is never the session city, and a trip with no other city has no session event", () => {
  const trips = journey();
  trips[0].cities = ["Ahmedabad", "Sabarmati (Station)", "Bengaluru"];
  assert.ok(titles(trips).includes("In Bengaluru (full day)"));
  trips[0].cities = ["Ahmedabad"];
  assert.ok(!titles(trips).some((t) => t.startsWith("In ") && t.includes("Ahmedabad")));
  assert.equal(desiredFamilyEvents([{ ...trips[0], cities: [] }], TODAY).filter((e) => e.kind === "session").length, 0);
});

test("cancelled trips, past days and days beyond 120 are left out; the edges are in", () => {
  const trips = journey();
  trips[1].status = "cancelled";
  assert.ok(!titles(trips).some((t) => t.includes("Delhi to Surat") || t === "In Delhi (full day)"));
  // Past events stay for 30 days: the leg of 6 Oct is in on 5 Nov, out on 6 Nov.
  const has = (today: string) => desiredFamilyEvents(journey(), today).some((e) => e.payload.summary.includes("Ahmedabad to Bengaluru"));
  assert.equal(has("2026-10-07"), true, "the morning after, mid-trip");
  assert.equal(has("2026-11-05"), true);
  assert.equal(has("2026-11-06"), false);
  // 120 days after 2026-10-01 is 2026-01-29 of the next year: 2027-01-29.
  const far = [{ ...journey()[1], session_date: "2027-01-29", legs: [] }, { ...journey()[1], id: "x", session_date: "2027-01-30", legs: [] }];
  assert.deepEqual(desiredFamilyEvents(far, TODAY).map((e) => e.item_key), ["2027-01-29"]);
});

test("a leg's key does not depend on its position, so removing one leg shifts nothing else", () => {
  const before = desiredFamilyEvents(journey(), TODAY);
  const trips = journey();
  (trips[0].legs as unknown[]).shift();
  const after = desiredFamilyEvents(trips, TODAY);
  const keys = (es: typeof before) => new Set(es.map((e) => `${e.trip_id}|${e.kind}|${e.item_key}`));
  const gone = [...keys(before)].filter((k) => !keys(after).has(k));
  assert.equal(gone.length, 1);
  assert.match(gone[0], /ahmedabad\|bengaluru/);
  // Two identical legs on one day still get two events.
  const twin = { ...journey()[1], legs: [
    { from: "Surat", to: "Vadodara", date: "2026-10-08", mode: "cab", cost: null, time: "09:00" },
    { from: "Surat", to: "Vadodara", date: "2026-10-08", mode: "cab", cost: null, time: "15:00" },
  ] };
  assert.equal(desiredFamilyEvents([twin], TODAY).filter((e) => e.kind === "leg").length, 2);
});

// --- 2. the sync ------------------------------------------------------------------

// An in-memory Google calendar plus the recorded table. `log` is every write.
function world() {
  const calendar = new Map<string, FamilyEventPayload>();
  const records: RecordedEvent[] = [];
  const log: string[] = [];
  let n = 0;
  // An event Life OS did not write: it must survive everything.
  calendar.set("foreign-1", { summary: "Dentist", start: { date: "2026-10-07" }, end: { date: "2026-10-08" }, reminders: { useDefault: false, overrides: [] } });
  // Which Google calendar each event sits on; `current` is the chosen one.
  const calOf = new Map<string, string>();
  const state = { current: "cal-family" };
  const io: FamilyIO & { failRemove?: boolean; goneIds: Set<string> } = {
    goneIds: new Set(),
    async create(p) {
      const id = `g${++n}`;
      calendar.set(id, p);
      calOf.set(id, state.current);
      log.push(`create ${id}`);
      return id;
    },
    async patch(cal, id, p) {
      assert.equal(calOf.get(id), cal, "a patch goes to the calendar the event is on");
      if (!calendar.has(id) || io.goneIds.has(id)) return false;
      // The body Google would get: the unused field is explicitly null.
      const body = familyPatchBody(p) as { start: Record<string, unknown> };
      assert.ok("date" in body.start && "dateTime" in body.start, "patch names both fields");
      calendar.set(id, p);
      log.push(`patch ${id}`);
      return true;
    },
    async remove(cal, id) {
      assert.equal(calOf.get(id) ?? cal, cal, "a delete goes to the calendar the event is on");
      if (io.failRemove) throw new Error("boom");
      calendar.delete(id);
      log.push(`remove ${id}`);
    },
    async record(row) {
      const at = row.id ? records.findIndex((r) => r.id === row.id) : -1;
      if (at >= 0) records[at] = { ...records[at], ...row, id: row.id! };
      else records.push({ id: `r${records.length + 1}-${row.item_key}`, ...row });
    },
    async forget(id) {
      records.splice(records.findIndex((r) => r.id === id), 1);
    },
  };
  const run = (trips: FamilyTrip[]) => runFamilySync(desiredFamilyEvents(trips, TODAY), records, io, state.current);
  return { calendar, records, log, io, run, state, calOf };
}

test("the first run writes every event, and a second run with no change writes nothing", async () => {
  const w = world();
  const first = await w.run(journey());
  assert.deepEqual(first, { created: 8, updated: 0, deleted: 0, failed: 0 });
  assert.equal(w.records.length, 8);
  assert.equal(w.calendar.size, 9, "eight of ours and the dentist");
  const writes = w.log.length;
  const second = await w.run(journey());
  assert.deepEqual(second, { created: 0, updated: 0, deleted: 0, failed: 0 });
  assert.equal(w.log.length, writes, "no Google call at all");
});

test("changing one leg's time updates exactly one event", async () => {
  const w = world();
  await w.run(journey());
  const trips = journey();
  (trips[0].legs as { time: string }[])[0].time = "08:10";
  const r = await w.run(trips);
  assert.deepEqual(r, { created: 0, updated: 1, deleted: 0, failed: 0 });
  assert.equal(w.log.filter((l) => l.startsWith("patch")).length, 1);
  const moved = [...w.calendar.values()].find((p) => p.summary === "Flight Ahmedabad to Bengaluru")!;
  assert.deepEqual(moved.start, { dateTime: "2026-10-06T08:10:00+05:30", timeZone: "Asia/Kolkata" });
});

test("giving an all-day leg a time turns it into a timed event in place", async () => {
  const w = world();
  await w.run(journey());
  const trips = journey();
  (trips[1].legs as Record<string, unknown>[])[0].time = "20:00";
  const r = await w.run(trips);
  assert.deepEqual(r, { created: 0, updated: 1, deleted: 0, failed: 0 });
  const p = [...w.calendar.values()].find((x) => x.summary === "Flight Delhi to Surat")!;
  assert.ok("dateTime" in p.start);
  assert.equal(p.transparency, undefined);
  assert.equal(familyPatchBody(p).transparency, "opaque", "the patch overrides the old transparent flag");
  assert.equal([...w.calendar.values()].some((x) => x.summary.includes("time to be confirmed")), false);
});

test("removing a leg deletes only that leg's event", async () => {
  const w = world();
  await w.run(journey());
  const trips = journey();
  (trips[2].legs as unknown[]).pop(); // the Surat airport cab
  const r = await w.run(trips);
  assert.deepEqual(r, { created: 0, updated: 0, deleted: 1, failed: 0 });
  assert.equal(w.calendar.size, 8);
  assert.ok(![...w.calendar.values()].some((p) => p.summary === "Cab Surat Airport to Surat"));
  assert.ok(w.calendar.has("foreign-1"));
});

test("cancelling a trip deletes its events and no other trip's", async () => {
  const w = world();
  await w.run(journey());
  const trips = journey();
  trips[0].status = "cancelled";
  const r = await w.run(trips);
  assert.equal(r.deleted, 3, "its session day and its two legs");
  assert.equal(r.created + r.updated, 0);
  assert.ok([...w.calendar.values()].some((p) => p.summary === "In Delhi (full day)"));
  assert.ok(!w.records.some((x) => x.trip_id === "t-blr"));
});

test("a deleted trip (its id now null on the record) loses its events too", async () => {
  const w = world();
  await w.run(journey());
  for (const r of w.records) if (r.trip_id === "t-del") r.trip_id = null; // on delete set null
  const r = await w.run(journey().filter((t) => t.id !== "t-del"));
  assert.equal(r.deleted, 2);
  assert.ok(!w.records.some((x) => x.trip_id === null));
});

test("an event on the calendar that Life OS did not write is never touched, whatever happens", async () => {
  const w = world();
  await w.run(journey());
  await w.run([]); // nothing wanted
  assert.deepEqual([...w.calendar.keys()], ["foreign-1"]);
  assert.equal(w.log.some((l) => l.includes("foreign-1")), false, "never named in any call");
  // Even a lookalike: same title and day as ours, but not recorded.
  w.calendar.set("lookalike", { summary: "In Delhi (full day)", start: { date: "2026-10-08" }, end: { date: "2026-10-09" }, reminders: { useDefault: false, overrides: [] } });
  await w.run(journey());
  await w.run([]);
  assert.ok(w.calendar.has("lookalike"));
});

test('choosing "None" removes every recorded event and the records', async () => {
  const w = world();
  await w.run(journey());
  const r = await w.run([]);
  assert.equal(r.deleted, 8);
  assert.equal(w.records.length, 0);
  assert.equal(w.calendar.size, 1);
});

test("an event deleted by hand in Google is recreated, and a failed delete is retried next time", async () => {
  const w = world();
  await w.run(journey());
  const victim = w.records.find((r) => r.item_key === "2026-10-08")!;
  w.io.goneIds.add(victim.ext_event_id);
  const trips = journey();
  trips[1].cities = ["Delhi NCR"]; // changes that session's title, so a patch is tried
  const r = await w.run(trips);
  assert.equal(r.updated, 1);
  assert.notEqual(w.records.find((x) => x.id === victim.id)!.ext_event_id, victim.ext_event_id, "a fresh event");

  w.io.failRemove = true;
  const failed = await w.run([]);
  assert.equal(failed.failed, 8);
  assert.equal(w.records.length, 8, "records stay, so the next run tries again");
  w.io.failRemove = false;
  assert.equal((await w.run([])).deleted, 8);
});

test("a delete or patch goes to the calendar the event was recorded on, and switching calendars moves events", async () => {
  const w = world();
  await w.run(journey()); // all on cal-family
  w.state.current = "cal-other"; // the family calendar changed
  const moved = await w.run(journey());
  assert.deepEqual(moved, { created: 0, updated: 8, deleted: 0, failed: 0 });
  assert.ok(w.records.every((r) => r.ext_calendar_id === "cal-other"));
  assert.equal([...w.calOf.values()].filter((c) => c === "cal-family").length, 8, "old ones were removed from cal-family by id, new ones created on cal-other");
  assert.equal(w.calendar.size, 9);
  // A clear (no calendar needed) still deletes from where each record sits.
  const gone = await runFamilySync([], w.records, w.io, "");
  assert.equal(gone.deleted, 8);
});

test("planFamilySync is a pure plan: create, update, remove", () => {
  const d = desiredFamilyEvents(journey(), TODAY);
  const recorded: RecordedEvent[] = d.slice(0, 3).map((e, i) => ({ id: `r${i}`, trip_id: e.trip_id, kind: e.kind, item_key: e.item_key, ext_event_id: `x${i}`, ext_calendar_id: "cal-family", content_hash: i === 0 ? "stale" : e.hash }));
  recorded.push({ id: "r9", trip_id: "gone", kind: "leg", item_key: "k", ext_event_id: "x9", ext_calendar_id: "cal-family", content_hash: "h" });
  const plan = planFamilySync(d, recorded, "cal-family");
  assert.equal(plan.create.length, d.length - 3);
  assert.equal(plan.update.length, 1);
  assert.deepEqual(plan.remove.map((r) => r.id), ["r9"]);
});

// --- 3. leg time ----------------------------------------------------------------------

test("a leg time is HH:MM, 24-hour: 07:05 and 19:00 pass; 7pm, 25:00, 7:05 and 19:60 do not", () => {
  for (const ok of ["07:05", "19:00", "00:00", "23:59"]) assert.deepEqual(checkLegTime(ok), { ok: true, time: ok });
  for (const bad of ["7pm", "25:00", "7:05", "19:60", "19:00:00", "noon", 1900]) assert.equal(checkLegTime(bad).ok, false, String(bad));
  for (const none of [undefined, null, "", "  "]) assert.deepEqual(checkLegTime(none), { ok: true, time: null });
  assert.deepEqual(parseLegs([{ from: "A", to: "B", date: "2026-10-01", mode: "cab", time: "7pm" }])[0].time, undefined, "a bad time in the column is dropped on read");
  assert.equal(parseLegs([{ from: "A", to: "B", date: "2026-10-01", mode: "cab", time: "07:05" }])[0].time, "07:05");
});

test("every tool takes the time as one plain string, optional", () => {
  for (const t of [toolByName("log_trip_leg")!, toolByName("update_trip_leg")!, TICKET_TOOL]) {
    const props = t.input_schema.properties as Record<string, { type: unknown }>;
    assert.equal(props.time.type, "string", t.name);
    assert.ok(!((t.input_schema.required ?? []) as string[]).includes("time"), t.name);
  }
});

function seed() {
  resetDb();
  db.trips = [];
  db.trip_expenses = [];
  db.work_streams.push({ id: "ws-icai", name: "ICAI", user_id: USER });
  db.trips.push({ id: "t1", user_id: USER, title: "t1", purpose: "aica", work_stream_id: "ws-icai", cities: ["Surat"], legs: [], status: "planned" });
}

test("log_trip_leg stores a good time and refuses a bad one, and undo takes it back", async () => {
  seed();
  const out = await executeToolCall("log_trip_leg", { trip_id: "t1", from_city: "Ahmedabad", to_city: "Surat", date: "2026-10-09", mode: "vande_bharat", time: "07:05" });
  assert.equal((db.trips[0].legs as { time: string }[])[0].time, "07:05");
  await undoExecutedAction(String(out.actionId));
  assert.deepEqual(db.trips[0].legs, []);
  for (const bad of ["7pm", "25:00"]) {
    await assert.rejects(
      () => executeToolCall("log_trip_leg", { trip_id: "t1", from_city: "A", to_city: "B", date: "2026-10-09", mode: "cab", time: bad }),
      /HH:MM/
    );
  }
  assert.deepEqual(db.trips[0].legs, [], "a refused time writes nothing");
});

test("update_trip_leg sets a time, refuses a bad one, and undo restores the legs exactly", async () => {
  seed();
  db.trips[0].legs = [{ from: "Surat", to: "Ahmedabad", date: "2026-10-09", mode: "cab", cost: null }];
  const before = JSON.stringify(db.trips[0].legs);
  const out = await executeToolCall("update_trip_leg", { trip_id: "t1", leg_index: 0, time: "19:00" });
  assert.equal((db.trips[0].legs as { time: string }[])[0].time, "19:00");
  await undoExecutedAction(String(out.actionId));
  assert.equal(JSON.stringify(db.trips[0].legs), before, "undo covers the time");
  await assert.rejects(() => executeToolCall("update_trip_leg", { trip_id: "t1", leg_index: 0, time: "25:00" }), /HH:MM/);
  assert.equal(editLeg([{ from: "A", to: "B", date: "2026-10-01", mode: "cab" }], 0, { time: "7pm" }).ok, false);
  // Editing something else keeps the time.
  const kept = editLeg([{ from: "A", to: "B", date: "2026-10-01", mode: "cab", time: "07:05" }], 0, { mode: "flight" });
  assert.ok(kept.ok && kept.legs[0].time === "07:05");
});

test("the ticket proposal takes a time the ticket states, and leaves it empty when it is not HH:MM", () => {
  const trips = [{ id: "t1", start_date: "2026-10-08", end_date: "2026-10-09", legs: [], cities: ["Surat"] }];
  const call = (time: unknown, ref: string) => ({
    name: "propose_trip_leg",
    input: { external_ref: ref, from_city: "Delhi", to_city: "Surat", date: "2026-10-08", mode: "flight", ...(time === undefined ? {} : { time }) },
  });
  const ok = validateTripLegProposals([call("07:05", "m1")], new Set(["m1"]), trips);
  assert.equal(ok.accepted[0].leg.time, "07:05");
  const noTime = validateTripLegProposals([call(undefined, "m1")], new Set(["m1"]), trips);
  assert.equal(noTime.accepted[0].leg.time, undefined);
  const bad = validateTripLegProposals([call("7pm", "m1")], new Set(["m1"]), trips);
  assert.equal(bad.accepted.length, 1, "the leg is still recorded");
  assert.equal(bad.accepted[0].leg.time, undefined, "without the time");
  assert.ok(bad.rejected.some((r) => /not HH:MM/.test(r)));
  assert.match(src("lib/assistant/execute.ts"), /\.\.\.\(t\.leg\.time \? \{ time: t\.leg\.time \} : \{\}\)/, "the scan passes the time to the leg write");
});

test("lifeos_list_trips legs return the time", () => {
  assert.match(src("lib/assistant/mcp-api.ts"), /time: l\.time \?\? null/);
});

// --- 4. shape ------------------------------------------------------------------------

test("the migration adds the flag, one-per-user index, the events table and RLS, and is not applied by anything", () => {
  const sql = src("supabase/migrations/20261002000100_b29_family_travel.sql");
  assert.match(sql, /alter table calendars add column if not exists is_family_travel boolean;/);
  assert.match(sql, /create unique index if not exists calendars_one_family_travel\s+on calendars \(user_id\) where is_family_travel;/);
  assert.match(sql, /create table if not exists family_travel_events/);
  assert.match(sql, /user_id uuid not null default auth\.uid\(\) references auth\.users/);
  assert.match(sql, /alter table family_travel_events enable row level security;/);
  assert.match(sql, /using \(user_id = \(select auth\.uid\(\)\)\)/);
  for (const col of ["trip_id", "kind", "item_key", "ext_event_id", "content_hash"]) assert.ok(sql.includes(col), col);
  assert.match(sql, /trip_id uuid references trips \(id\) on delete set null/);
  assert.doesNotMatch(sql, /\bdrop table\b|\bdelete from\b|\bupdate trips\b/i);
  // No event text can be stored: there is no column for a title, city or time.
  const table = sql.slice(sql.indexOf("create table if not exists family_travel_events"), sql.indexOf("alter table family_travel_events"));
  assert.doesNotMatch(table, /\b(title|summary|city|description|notes?|time|payload)\b\s+(text|jsonb|timestamptz)/i);
  // The cloud scripts and the deploy never apply it as part of this change.
  assert.ok(!src("package.json").includes("db push"));
});

test("only the owner-session Settings action can choose the calendar; no tool or connector can", () => {
  for (const t of TOOLS) assert.ok(!JSON.stringify(t).includes("family_travel"), t.name);
  for (const f of ["lib/assistant/tools.ts", "lib/assistant/execute.ts", "lib/assistant/mcp-api.ts", "lib/assistant/core.ts"]) {
    assert.ok(!/family_travel|syncFamilyTravel|clearFamilyTravel/.test(src(f)), f);
  }
  const actions = src("app/(app)/settings/actions.ts");
  assert.match(actions, /export async function setFamilyTravelCalendarAction/);
  assert.match(actions, /requireUser\("\/settings"\)/);
  // The old calendar is cleared before the flag moves.
  const body = actions.slice(actions.indexOf("export async function setFamilyTravelCalendarAction"), actions.indexOf("export async function setCalendarSyncAction"));
  assert.ok(body.indexOf("clearFamilyTravel") < body.indexOf("is_family_travel: false"));
  assert.ok(body.includes("is_reminder_home"), "the reminder-home calendar is refused");
});

test("the sync runs after every trip write and in the brief cron, goes through withResourceAuth, and logs no event text", () => {
  const write = src("lib/trips/write.ts");
  assert.equal((write.match(/syncFamilyTravel\(userId\)/g) ?? []).length, 3, "create, update and delete");
  assert.match(src("app/api/cron/brief/route.ts"), /await syncFamilyTravel\(userId\);/);
  const sync = src("lib/family/sync.ts");
  assert.match(sync, /gcalCreate|gcalPatch|gcalDelete/);
  assert.ok(!sync.includes("fetch("), "no raw Google call: the writer's calls carry withResourceAuth");
  assert.match(src("lib/reminders/writer.ts"), /withResourceAuth\(accountId, \(token\) =>\s+fetch\(`\$\{gcalUrl\(calExtId\)\}\?sendUpdates=none`/);
  assert.ok(!/console\./.test(sync), "nothing is logged to the console");
  const audit = sync.slice(sync.indexOf("async function logFailure"), sync.indexOf("export async function syncFamilyTravel"));
  assert.ok(!/summary|payload|title|city/.test(audit), "the failure row carries counts and a reason only");
  // It never throws into a trip write.
  const fn = sync.slice(sync.indexOf("export async function syncFamilyTravel"), sync.indexOf("export async function clearFamilyTravel"));
  assert.match(fn, /catch \(e\)/);
  // The pure module reads none of the private fields.
  const pure = src("lib/family/travel.ts");
  for (const field of [".title", ".notes", ".session_label", ".work_stream", ".purpose", ".ref", ".cost"]) {
    assert.ok(!pure.includes(`t${field}`) && !pure.includes(`leg${field}`), `travel.ts reads ${field}`);
  }
});

test("the migration records the calendar of each event and keeps the family calendar off the home and write-back calendars", () => {
  const sql = src("supabase/migrations/20261002000100_b29_family_travel.sql");
  assert.match(sql, /ext_calendar_id text not null/);
  assert.match(sql, /if new\.is_primary_write then\s+raise exception/);
  assert.match(sql, /if new\.is_reminder_home then\s+raise exception/);
});

test("Settings: the family choice excludes the write-back calendar, refuses to move the flag when the clear did not run, and the reminder-home change checks first", () => {
  const actions = src("app/(app)/settings/actions.ts");
  const fam = actions.slice(actions.indexOf("export async function setFamilyTravelCalendarAction"), actions.indexOf("export async function setCalendarSyncAction"));
  assert.match(fam, /data\.is_primary_write/);
  assert.match(fam, /if \(!cleared\.ran\) \{\s+return \{ ok: false/);
  assert.ok(fam.indexOf("if (!cleared.ran)") < fam.indexOf("is_family_travel: false"), "refused before the flag moves");
  assert.match(src("components/accounts-panel.tsx"), /!c\.is_reminder_home && !c\.is_primary_write/);
  const home = actions.slice(actions.indexOf("export async function setReminderHomeAction"), actions.indexOf("export async function setFamilyTravelCalendarAction"));
  assert.ok(home.indexOf("is_family_travel") < home.indexOf("is_reminder_home: false"), "checked before the current home is cleared");
});

test("sync.ts checks every read it depends on, and only the clear passes an explicit empty set", () => {
  const sync = src("lib/family/sync.ts");
  for (const read of ["tripErr", "streamErr", "calErr", "acctErr"]) assert.ok(sync.includes(read), read);
  assert.match(sync, /if \(error \|\| !recorded\) throw new ReadFailed/);
  assert.match(sync, /runOn\(svc, userId, null, null, \[\]\)/);
});

test("B29 is documented with the privacy rule verbatim", () => {
  const doc = src("CLAUDE.md").replace(/\s+/g, " ");
  assert.match(doc, /## Family travel calendar \(B29\)/);
  assert.ok(
    doc.includes(
      "she sees the city, the session days, and each leg's mode, time and route. Nothing else: no PNRs or booking references, no hotel details, no client or organisation names (not ICAI, not Cygnet, not the trip title, notes, work stream, purpose or session label), no amounts."
    )
  );
});
