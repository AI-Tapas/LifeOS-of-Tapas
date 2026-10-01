// Offline proof for B28: journeys with several sessions, and non-ICAI (client)
// training trips. Run: npm run test:b28 (Node 22.18+, native TS type
// stripping). No network, no database: pure logic, plus the real executor and
// the real lib/trips/write.ts against an in-memory database (b28-loader.mjs,
// b28-stubs.ts). Synthetic data only.
//
// What is proven:
//   1. Overlapping sessions: a date that fits two trips goes to the nearest
//      session date, a tie to the later trip; a ride goes to the session in
//      whose CITY it happens, and a ticket to its destination's session.
//   2. The home city is never stored in a trip's cities, on create and on
//      update; legs are left exactly as written.
//   3. An expense moves between his trips, undo puts it back, a trip that is
//      not his is refused.
//   4. The month pack has an ICAI view and a client view, neither with a total.
//   5. A client-arranged session has exactly three checklist steps, once.
//   6. Every enum value has a label, and the two migrations are shaped right.
//   7. Journeys: folding, the join by same_journey_as, undo, the schemas.

import { register } from "node:module";
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { tripForDate, validateTripLegProposals } from "../lib/trips/ticket.ts";
import { validateCabProposals, type CabTrip } from "../lib/trips/cab.ts";
import { isHomeCity, stripHomeCity, PURPOSE_LABELS, TRIP_PURPOSES, parseLegs } from "../lib/trips/core.ts";
import {
  BILLS_TO_LABELS,
  BILLS_TO_VALUES,
  BILLS_TO_HELP,
  buildMonthPack,
  monthPackText,
  type MonthExpense,
  type MonthTrip,
} from "../lib/trips/month.ts";
import {
  HOTEL_ARRANGEMENTS,
  HOTEL_HINTS,
  HOTEL_LABELS,
  HOTEL_SENTENCES,
  buildChecklist,
  defaultHotelArrangement,
  isHotelStepTitle,
  type ChecklistTrip,
} from "../lib/trips/checklist.ts";
import { foldJourneys, journeyCities, nearestSession } from "../lib/trips/journey.ts";
import { expensePatch } from "../lib/trips/expense-edit.ts";
import { Constants } from "../lib/database.types.ts";
import { MCP_READ_TOOLS, schemaStats, toolByName } from "../lib/assistant/tools.ts";
import { db, resetDb, fakeSupabase } from "./b26-stubs.ts";

register("./b28-loader.mjs", import.meta.url);
const { executeToolCall, undoExecutedAction } = await import("../lib/assistant/execute.ts");
const { runReadTool, READ_TOOL_SCHEMAS } = await import("../lib/assistant/mcp-api.ts");
const write = await import("../lib/trips/write.ts");

const src = (rel: string) => readFileSync(new URL("../" + rel, import.meta.url), "utf8");
const USER = "user-1";

// ---------------------------------------------------------------------------
// The journey in his own words: Bengaluru (Cygnet, session 7 Oct, trip 6 to
// 7), Delhi (Cygnet, session 8 Oct, trip 7 to 8), Surat (ICAI, session 9 Oct,
// trip 8 to 9).
// ---------------------------------------------------------------------------
const BLR: CabTrip = { id: "blr", title: "Cygnet Bengaluru", start_date: "2026-10-06", end_date: "2026-10-07", session_date: "2026-10-07", cities: ["Bengaluru"], legs: [] };
const DEL: CabTrip = { id: "del", title: "Cygnet Delhi", start_date: "2026-10-07", end_date: "2026-10-08", session_date: "2026-10-08", cities: ["Delhi"], legs: [] };
const SRT: CabTrip = { id: "srt", title: "AICA Surat", start_date: "2026-10-08", end_date: "2026-10-09", session_date: "2026-10-09", cities: ["Surat"], legs: [] };
const TRIPS = [SRT, BLR, DEL]; // deliberately not in order: matching must not depend on it

// --- 1. overlap matching -----------------------------------------------------

test("a date held by one trip goes to that trip", () => {
  assert.equal(tripForDate(TRIPS, "2026-10-06")?.id, "blr");
  assert.equal(tripForDate(TRIPS, "2026-10-09")?.id, "srt");
});

test("a date held by two trips goes to the nearest session date", () => {
  // 7 Oct is Bengaluru's own session day and a travel day for Delhi.
  assert.equal(tripForDate(TRIPS, "2026-10-07")?.id, "blr");
  // 8 Oct is Delhi's own session day and a travel day for Surat.
  assert.equal(tripForDate(TRIPS, "2026-10-08")?.id, "del");
});

test("a tie goes to the later trip, the one he is travelling to", () => {
  // Sessions 7 and 9, a date between them: both are one day away.
  const early: CabTrip = { ...BLR, id: "early", start_date: "2026-10-07", end_date: "2026-10-08", session_date: "2026-10-07" };
  const late: CabTrip = { ...SRT, id: "late", start_date: "2026-10-08", end_date: "2026-10-09", session_date: "2026-10-09" };
  assert.equal(tripForDate([early, late], "2026-10-08")?.id, "late");
  assert.equal(tripForDate([late, early], "2026-10-08")?.id, "late", "whatever order the trips arrive in");
});

test("a trip with no session date is judged by its end date", () => {
  const a: CabTrip = { ...BLR, id: "a", session_date: null, start_date: "2026-10-07", end_date: "2026-10-07" };
  const b: CabTrip = { ...DEL, id: "b", session_date: null, start_date: "2026-10-07", end_date: "2026-10-09" };
  assert.equal(tripForDate([b, a], "2026-10-07")?.id, "a");
});

test("slack still finds a trip for the evening before, and nothing farther", () => {
  assert.equal(tripForDate(TRIPS, "2026-10-05", 1)?.id, "blr");
  assert.equal(tripForDate(TRIPS, "2026-10-04", 1), null);
  assert.equal(tripForDate([{ ...BLR, start_date: null }], "2026-10-06"), null, "an undated trip cannot be matched");
});

function ride(over: Record<string, unknown>) {
  return {
    name: "propose_cab_expense",
    input: {
      external_ref: "m1",
      provider: "uber",
      ride_date: "2026-10-08",
      ride_time: "19:30",
      amount: 320,
      from_area: "Surat Airport",
      to_area: "Hotel",
      ...over,
    },
  };
}
const SENDERS = new Map([["m1", "uber" as const], ["m2", "uber" as const], ["m3", "uber" as const]]);

test("a ride belongs to the session in whose city it happens", () => {
  // 8 Oct is the Delhi session date, but the Surat arrival ride is Surat's.
  const surat = validateCabProposals([ride({ from_area: "Surat Airport", to_area: "Hotel" })], SENDERS, TRIPS);
  assert.equal(surat.accepted[0].trip_id, "srt");
  // "Hotel, Delhi" to "Delhi Airport" stays with Delhi.
  const delhi = validateCabProposals(
    [ride({ external_ref: "m2", from_area: "Hotel, Delhi", to_area: "Delhi Airport" })],
    SENDERS,
    TRIPS
  );
  assert.equal(delhi.accepted[0].trip_id, "del");
  // The raw area decides, but only the cleaned area is stored.
  assert.equal(delhi.accepted[0].from_area, "Hotel");
});

test("a ride from home at the start of the journey falls to the first session", () => {
  const r = validateCabProposals(
    [ride({ external_ref: "m3", ride_date: "2026-10-06", from_area: "Home", to_area: "Ahmedabad Airport" })],
    SENDERS,
    TRIPS
  );
  assert.equal(r.accepted[0].trip_id, "blr");
});

test("a city match beats the date rule, and the date rule still decides without one", () => {
  const nocity = validateCabProposals([ride({ from_area: "Airport", to_area: "Hotel" })], SENDERS, TRIPS);
  assert.equal(nocity.accepted[0].trip_id, "del", "no city in the ride: nearest session date, 8 Oct is Delhi");
  const home = validateCabProposals(
    [ride({ ride_date: "2026-10-08", from_area: "Ahmedabad", to_area: "Surat" })],
    SENDERS,
    TRIPS
  );
  assert.equal(home.accepted[0].trip_id, "srt", "the home city never counts as a session city");
});

test("a personal ride still stores nothing", () => {
  const r = validateCabProposals([ride({ ride_date: "2026-11-20" })], SENDERS, TRIPS);
  assert.equal(r.accepted.length, 0);
  assert.equal(r.personal, 1);
});

test("a ticket Delhi to Surat on 8 Oct lands on Surat", () => {
  const calls = [
    { name: "propose_trip_leg", input: { external_ref: "t1", from_city: "Delhi", to_city: "Surat", date: "2026-10-08", mode: "flight", reference: "PNR123" } },
  ];
  const r = validateTripLegProposals(calls, new Set(["t1"]), TRIPS);
  assert.equal(r.accepted[0].trip_id, "srt");
  // Without the destination the date alone would have said Delhi.
  assert.equal(tripForDate(TRIPS, "2026-10-08")?.id, "del");
});

test("the scan's trip queries are ordered, so a run is repeatable", () => {
  const scan = src("lib/assistant/scan.ts");
  const queries = scan.match(/\.from\("trips"\)[\s\S]*?\.order\("id", \{ ascending: true \}\);/g) ?? [];
  assert.equal(queries.length, 2, "the ticket query and the cab query both order by start date, then id");
  for (const q of queries) assert.match(q, /\.order\("start_date", \{ ascending: true \}\)/);
});

// --- 2. the home city ---------------------------------------------------------

test("the home city is recognised by prefix, case insensitive", () => {
  for (const c of ["Ahmedabad", "ahmedabad", "Ahmedabad (Ambli Road)", "Sabarmati", " SABARMATI JN "]) {
    assert.equal(isHomeCity(c), true, c);
  }
  for (const c of ["Rajkot", "Surat", "New Ahmedabad Colony", ""]) assert.equal(isHomeCity(c), false, c);
  assert.deepEqual(stripHomeCity(["Ahmedabad", "Rajkot", "Sabarmati", "Surat"]), ["Rajkot", "Surat"]);
});

function seed() {
  resetDb();
  db.trips = [];
  db.trip_expenses = [];
  db.work_streams.push({ id: "ws-icai", name: "ICAI", user_id: USER }, { id: "ws-cygnet", name: "Cygnet", user_id: USER }, { id: "ws-personal", name: "Personal", user_id: USER });
}

test("create and update strip the home city and leave legs untouched", async () => {
  seed();
  const legs = [{ from: "Ahmedabad", to: "Rajkot", date: "2026-10-12", mode: "cab" as const, cost: null }];
  const made = await write.createTrip(fakeSupabase as never, USER, {
    purpose: "aica",
    title: "AICA Rajkot",
    work_stream_id: "ws-icai",
    cities: ["Ahmedabad", "Rajkot", "Ahmedabad (Ambli Road)", "Sabarmati"],
    legs,
  });
  assert.ok(made.ok);
  const row = db.trips.find((t) => t.id === (made as { id: string }).id)!;
  assert.deepEqual(row.cities, ["Rajkot"]);
  assert.deepEqual(row.legs, legs, "legs are stored exactly as written");

  const upd = await write.updateTrip(fakeSupabase as never, USER, row.id as string, { cities: ["Sabarmati", "Surat", "Ahmedabad"] });
  assert.ok(upd.ok);
  assert.deepEqual(row.cities, ["Surat"]);
  assert.deepEqual(row.legs, legs, "an update of the cities leaves the legs alone");
});

// --- 3. moving an expense between sessions -------------------------------------

function addTrip(id: string, over: Record<string, unknown> = {}) {
  db.trips.push({ id, user_id: USER, title: id, purpose: "aica", work_stream_id: "ws-icai", cities: [], journey_id: null, ...over });
}
function addExpense(id: string, trip_id: string, over: Record<string, unknown> = {}) {
  const row = { id, user_id: USER, trip_id, category: "transport", amount: 450, date: "2026-10-06", billable: true, receipt_ref: null, ...over };
  db.trip_expenses.push(row);
  return row;
}

test("an expense moves to another of his trips, and undo puts it back", async () => {
  seed();
  addTrip("t-blr");
  addTrip("t-srt");
  const e = addExpense("e1", "t-blr");
  const out = await executeToolCall("update_trip_expense", { expense_id: "e1", trip_id: "t-srt" });
  assert.equal(e.trip_id, "t-srt", "the whole expense moved, nothing was split");
  assert.equal(e.amount, 450);
  const undone = await undoExecutedAction(String(out.actionId));
  assert.equal(undone.ok, true);
  assert.equal(e.trip_id, "t-blr", "undo restores the old trip");
});

test("a target that is not his trip is refused, and the expense stays", async () => {
  seed();
  addTrip("t-blr");
  db.trips.push({ id: "t-theirs", user_id: "someone-else", title: "x", purpose: "aica", work_stream_id: "ws-icai", cities: [] });
  const e = addExpense("e1", "t-blr");
  const r = await write.updateTripExpense(fakeSupabase as never, USER, "e1", { trip_id: "t-theirs" });
  assert.equal(r.ok, false);
  const missing = await write.updateTripExpense(fakeSupabase as never, USER, "e1", { trip_id: "nope" });
  assert.equal(missing.ok, false);
  assert.equal(e.trip_id, "t-blr");
});

test("trip_id is a checked part of the expense edit patch", () => {
  const ok = expensePatch({ trip_id: " t-2 " });
  assert.ok(ok.ok && ok.value.trip_id === "t-2");
  assert.equal(expensePatch({ trip_id: 5 }).ok, false);
  assert.equal(expensePatch({}).ok, false);
  const props = toolByName("update_trip_expense")!.input_schema.properties as Record<string, { type: string; enum?: string[] }>;
  assert.equal(props.trip_id.type, "string");
  assert.ok(!((toolByName("update_trip_expense")!.input_schema.required ?? []) as string[]).includes("trip_id"));
});

// --- 4. the month pack per claim -------------------------------------------------

const MTRIPS: MonthTrip[] = [
  { id: "a", title: "AICA Surat", start_date: "2026-10-08", end_date: "2026-10-09", cities: ["Surat"], bills_to: "icai_monthly", legs: [], stream_name: "ICAI" },
  { id: "c", title: "Cygnet Bengaluru", start_date: "2026-10-06", end_date: "2026-10-07", cities: ["Bengaluru"], bills_to: "client", legs: [{ from: "Ahmedabad", to: "Bengaluru", date: "2026-10-06", mode: "flight", cost: null }], stream_name: "Cygnet" },
  { id: "d", title: "Own training", start_date: "2026-10-20", end_date: "2026-10-21", cities: ["Pune"], bills_to: "none", legs: [], stream_name: "Cygnet" },
];
const MEXP: MonthExpense[] = [
  { id: "x1", trip_id: "a", category: "transport", amount: 300, date: "2026-10-08", billable: true, receipt_ref: "email:m1" },
  { id: "x2", trip_id: "c", category: "transport", amount: 520, date: "2026-10-06", billable: true, receipt_ref: "email:m2" },
  { id: "x3", trip_id: "c", category: "transport", amount: 410, date: "2026-10-07", billable: true, receipt_ref: null },
  { id: "x4", trip_id: "c", category: "other", amount: 90, date: "2026-10-07", billable: false, receipt_ref: null },
];

test("the ICAI view excludes a client session as 'Reimbursed by Cygnet'", () => {
  const pack = buildMonthPack(MTRIPS, MEXP, "2026-10");
  assert.deepEqual(pack.sessions.map((s) => s.trip_id), ["a"]);
  const cygnet = pack.excluded.find((x) => x.trip_id === "c")!;
  assert.equal(cygnet.reason, "Reimbursed by Cygnet");
  assert.doesNotMatch(cygnet.reason, /Not billable/);
  assert.equal(pack.excluded.find((x) => x.trip_id === "d")!.reason, "Not billable to anyone.");
  assert.deepEqual(pack.gaps, [], "the client's gaps are not an ICAI gap");
});

test("the Cygnet view lists only its reimbursable expenses, with receipt status", () => {
  const pack = buildMonthPack(MTRIPS, MEXP, "2026-10", "Cygnet");
  assert.equal(pack.claim_label, "Cygnet reimbursables");
  assert.deepEqual(pack.sessions.map((s) => s.trip_id), ["c"]);
  assert.deepEqual(pack.expense_groups[0].expenses.map((e) => e.id), ["x2", "x3"], "his own cost is not listed");
  assert.deepEqual(pack.gaps.map((g) => g.id), ["x3"]);
  assert.equal(pack.legs.length, 1);
  const text = monthPackText(pack);
  assert.match(text, /Cygnet reimbursables/);
  assert.match(text, /email:m2/);
  assert.match(text, /no receipt on file/);
  assert.doesNotMatch(text, /AICA Surat/, "the ICAI session is not on the Cygnet pack");
});

test("neither view carries a total or an invoice shape", () => {
  for (const claim of ["icai", "Cygnet"]) {
    const text = monthPackText(buildMonthPack(MTRIPS, MEXP, "2026-10", claim));
    assert.doesNotMatch(text, /^total|grand total|total:|invoice no|amount in words/im, claim);
    assert.match(text, /Records only\. No invoice number, no fee, no totals/);
  }
});

test("the connector's month pack takes a claim, one concrete type", async () => {
  seed();
  db.trips.push({ id: "c", user_id: USER, title: "Cygnet Bengaluru", start_date: "2026-10-06", end_date: "2026-10-07", cities: ["Bengaluru"], bills_to: "client", legs: [], work_streams: { name: "Cygnet" } });
  db.trips.push({ id: "a", user_id: USER, title: "AICA Surat", start_date: "2026-10-08", end_date: "2026-10-09", cities: ["Surat"], bills_to: "icai_monthly", legs: [], work_streams: { name: "ICAI" } });
  addExpense("x2", "c", { receipt_ref: "email:m2" });
  const claim = (READ_TOOL_SCHEMAS.lifeos_get_month_pack.properties as Record<string, { type: string }>).claim;
  assert.equal(claim.type, "string");
  const cygnet = await runReadTool("lifeos_get_month_pack", { month: "2026-10", claim: "Cygnet" });
  assert.equal((cygnet as { claim_label: string }).claim_label, "Cygnet reimbursables");
  assert.deepEqual((cygnet as { sessions: { trip_id: string }[] }).sessions.map((s) => s.trip_id), ["c"]);
  const icai = await runReadTool("lifeos_get_month_pack", { month: "2026-10" });
  assert.deepEqual((icai as { sessions: { trip_id: string }[] }).sessions.map((s) => s.trip_id), ["a"]);
});

// --- 5. the client-arranged checklist ----------------------------------------------

const CLIENT_TRIP: ChecklistTrip = {
  title: "Cygnet Bengaluru",
  purpose: "training",
  start_date: "2026-10-06",
  end_date: "2026-10-07",
  bills_to: "client",
  cities: ["Bengaluru"],
  hotel_arrangement: "client",
  stream_name: "Cygnet",
};

test("a client-arranged session has exactly three steps, dated from the trip", () => {
  const steps = buildChecklist(CLIENT_TRIP, "2026-09-01");
  assert.deepEqual(
    steps.map((s) => [s.title, s.due_date]),
    [
      ["Confirm flights booked by Cygnet", "2026-09-29"], // 7 days before the start
      ["Confirm hotel booked by Cygnet", "2026-10-01"], // 5 days before
      ["Collect cab receipts", "2026-10-07"], // the end date
    ]
  );
  assert.ok(!steps.some((s) => /Book (onward|return|hotel)/.test(s.title)), "no booking steps: the client books");
  for (const s of steps) assert.equal(s.reminder_mode, "in_app");
});

test("the client name falls back to 'the client'", () => {
  const steps = buildChecklist({ ...CLIENT_TRIP, stream_name: null }, "2026-09-01");
  assert.equal(steps[0].title, "Confirm flights booked by the client");
});

test("the hotel-step sync treats the client titles as app-written", () => {
  assert.equal(isHotelStepTitle("Confirm hotel booked by Cygnet"), true);
  assert.equal(isHotelStepTitle("Confirm hotel with the branch"), true);
  assert.equal(isHotelStepTitle("Book hotel"), true);
  assert.equal(isHotelStepTitle("Confirm flights booked by Cygnet"), false);
  assert.match(src("lib/trips/write.ts"), /isHotelStepTitle\(t\.title\)/);
});

test("seeding twice leaves three steps, not six", async () => {
  seed();
  addTrip("t-c", { purpose: "training", work_stream_id: "ws-cygnet", start_date: "2026-10-22", end_date: "2026-10-23", cities: ["Chennai"], bills_to: "client", hotel_arrangement: "client" });
  const first = await write.addTripChecklist(fakeSupabase as never, USER, "t-c");
  assert.ok(first.ok);
  assert.equal(db.tasks.filter((t) => t.trip_id === "t-c").length, 3);
  const second = await write.addTripChecklist(fakeSupabase as never, USER, "t-c");
  assert.equal(second.ok, false, "nothing to add the second time");
  assert.equal(db.tasks.filter((t) => t.trip_id === "t-c").length, 3);
  const titles = db.tasks.map((t) => t.title as string).sort();
  assert.deepEqual(titles, ["Collect cab receipts", "Confirm flights booked by Cygnet", "Confirm hotel booked by Cygnet"]);
});

test("a training defaults to bills_to none, and its hotel to the client for Cygnet only", async () => {
  assert.equal(defaultHotelArrangement("2026-10-06", "2026-10-07", "training", "Cygnet"), "client");
  assert.equal(defaultHotelArrangement("2026-10-06", "2026-10-07", "training", "cygnet"), "client");
  assert.equal(defaultHotelArrangement("2026-10-06", "2026-10-07", "training", "Individual training"), "self");
  assert.equal(defaultHotelArrangement("2026-10-06", "2026-10-06", "training", "Cygnet"), "same_day", "a day return needs no hotel");
  assert.equal(defaultHotelArrangement("2026-10-06", "2026-10-07", "aica", "Cygnet"), "branch", "only a training follows the stream");
  seed();
  const made = await write.createTrip(fakeSupabase as never, USER, {
    purpose: "training",
    title: "Cygnet Chennai",
    work_stream_id: "ws-cygnet",
    start_date: "2026-10-22",
    end_date: "2026-10-23",
  });
  assert.ok(made.ok);
  const row = db.trips.find((t) => t.id === (made as { id: string }).id)!;
  assert.equal(row.bills_to, "none");
  assert.equal(row.hotel_arrangement, "client");
  const own = await write.createTrip(fakeSupabase as never, USER, {
    purpose: "training",
    title: "Own training",
    work_stream_id: "ws-personal",
    start_date: "2026-10-22",
    end_date: "2026-10-23",
    bills_to: "client",
  });
  const row2 = db.trips.find((t) => t.id === (own as { id: string }).id)!;
  assert.equal(row2.bills_to, "client", "client stays selectable");
  assert.equal(row2.hotel_arrangement, "self");
});

// --- 6. labels everywhere, and the migrations -----------------------------------------

test("every enum value has a label, a hint and a sentence", () => {
  for (const p of Constants.public.Enums.trip_purpose) {
    assert.ok(PURPOSE_LABELS[p as keyof typeof PURPOSE_LABELS], `purpose ${p}`);
  }
  assert.deepEqual([...TRIP_PURPOSES], [...Constants.public.Enums.trip_purpose]);
  for (const b of Constants.public.Enums.trip_bills_to) {
    assert.ok(BILLS_TO_LABELS[b as keyof typeof BILLS_TO_LABELS], `bills_to ${b}`);
    assert.ok(BILLS_TO_HELP[b as keyof typeof BILLS_TO_HELP], `bills_to help ${b}`);
  }
  assert.deepEqual([...BILLS_TO_VALUES], [...Constants.public.Enums.trip_bills_to]);
  for (const h of Constants.public.Enums.hotel_arrangement) {
    const k = h as keyof typeof HOTEL_LABELS;
    assert.ok(HOTEL_LABELS[k] && HOTEL_HINTS[k] && HOTEL_SENTENCES[k], `hotel ${h}`);
  }
  assert.deepEqual([...HOTEL_ARRANGEMENTS], [...Constants.public.Enums.hotel_arrangement]);
  assert.equal(PURPOSE_LABELS.training, "Training (non-ICAI)");
  assert.equal(BILLS_TO_LABELS.client, "Reimbursed by the client");
  assert.equal(HOTEL_LABELS.client, "Client arranges");
});

test("the tool enums carry the new values and the list filter takes training", () => {
  for (const name of ["create_trip", "update_trip"]) {
    const props = toolByName(name)!.input_schema.properties as Record<string, { type: string; enum?: string[] }>;
    assert.ok(props.bills_to.enum!.includes("client"), `${name} bills_to`);
    assert.ok(props.hotel_arrangement.enum!.includes("client"), `${name} hotel_arrangement`);
  }
  const purpose = (toolByName("create_trip")!.input_schema.properties as Record<string, { enum?: string[] }>).purpose;
  assert.ok(purpose.enum!.includes("training"));
  const filter = (READ_TOOL_SCHEMAS.lifeos_list_trips.properties as Record<string, { enum?: string[] }>).purpose;
  assert.ok(filter.enum!.includes("training"));
  assert.match(src("lib/assistant/tools.ts"), /const enumOrNull = /);
});

test("migration A adds enum values only, and uses none of them", () => {
  const a = src("supabase/migrations/20261001000100_b28_enum_values.sql");
  const code = a.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");
  const stmts = code.split(";").map((s) => s.trim()).filter(Boolean);
  assert.equal(stmts.length, 3);
  for (const s of stmts) assert.match(s, /^alter type \w+ add value if not exists '\w+'$/);
  assert.match(code, /trip_purpose add value if not exists 'training'/);
  assert.match(code, /trip_bills_to add value if not exists 'client'/);
  assert.match(code, /hotel_arrangement add value if not exists 'client'/);
  assert.doesNotMatch(code, /\b(update|insert|create|default|where)\b/i, "nothing may USE a new value");
});

test("migration B adds journey_id, an index and the one-off home city clean", () => {
  const b = src("supabase/migrations/20261001000200_b28_journeys.sql");
  assert.match(b, /alter table trips add column if not exists journey_id uuid;/);
  assert.match(b, /create index if not exists trips_journey_id_idx on trips \(journey_id\)/);
  assert.doesNotMatch(b, /create table|references /i, "no journeys table, no foreign key");
  assert.match(b, /update trips t\s+set cities/);
  assert.match(b, /\^\(ahmedabad\|sabarmati\)/);
  assert.doesNotMatch(b, /\bleg(s)?\b\s*=/, "legs are not touched");
  assert.doesNotMatch(b, /'training'|'client'/, "migration B uses no new enum value");
});

// --- 7. journeys ---------------------------------------------------------------------------

const J = (id: string, journey_id: string | null, start: string, end: string, session: string | null, cities: string[]) => ({
  id,
  journey_id,
  start_date: start,
  end_date: end,
  session_date: session,
  cities,
});

test("sessions sharing a journey_id fold into one card, a lone trip looks as before", () => {
  const list = [
    J("solo", null, "2026-10-01", "2026-10-02", null, ["Rajkot"]),
    J("s3", "j1", "2026-10-08", "2026-10-09", "2026-10-09", ["Surat"]),
    J("s1", "j1", "2026-10-06", "2026-10-07", "2026-10-07", ["Ahmedabad", "Bengaluru"]),
    J("s2", "j1", "2026-10-07", "2026-10-08", "2026-10-08", ["Delhi"]),
    J("orphan", "j2", "2026-10-21", "2026-10-22", null, ["Chennai"]),
  ];
  const entries = foldJourneys(list);
  assert.deepEqual(entries.map((e) => e.kind), ["trip", "journey", "trip"], "a journey_id carried by one trip stays a plain trip");
  const j = entries[1];
  assert.ok(j.kind === "journey");
  assert.deepEqual(j.sessions.map((s) => s.id), ["s1", "s2", "s3"], "sessions in travel order");
  assert.equal(j.start, "2026-10-06");
  assert.equal(j.end, "2026-10-09");
  assert.deepEqual(journeyCities(j.sessions), ["Bengaluru", "Delhi", "Surat"], "home city out, travel order");
});

test("the journey page preselects the session nearest the date", () => {
  const sessions = [J("s1", "j", "2026-10-06", "2026-10-07", "2026-10-07", []), J("s2", "j", "2026-10-07", "2026-10-08", "2026-10-08", []), J("s3", "j", "2026-10-08", "2026-10-09", "2026-10-09", [])];
  assert.equal(nearestSession(sessions, "2026-10-06")?.id, "s1");
  assert.equal(nearestSession(sessions, "2026-10-09")?.id, "s3");
  assert.equal(nearestSession(sessions, "2026-12-01")?.id, "s3", "always answers, it only preselects");
  assert.equal(nearestSession([], "2026-10-09"), null);
});

test("create_trip joins a journey by same_journey_as, minting the id when there is none", async () => {
  seed();
  addTrip("t-blr", { start_date: "2026-10-06", end_date: "2026-10-07" });
  const out = await executeToolCall("create_trip", {
    purpose: "training",
    title: "Cygnet Delhi",
    work_stream: "Cygnet",
    start_date: "2026-10-07",
    end_date: "2026-10-08",
    same_journey_as: "t-blr",
  });
  const first = db.trips.find((t) => t.id === "t-blr")!;
  const made = db.trips.find((t) => t.title === "Cygnet Delhi")!;
  assert.match(String(first.journey_id), /^[0-9a-f-]{36}$/, "the other trip got a journey id too");
  assert.equal(made.journey_id, first.journey_id);
  // A third session joins the same journey through either member.
  await executeToolCall("create_trip", { purpose: "aica", title: "AICA Surat", start_date: "2026-10-08", end_date: "2026-10-09", same_journey_as: String(made.id) });
  assert.equal(db.trips.find((t) => t.title === "AICA Surat")!.journey_id, first.journey_id);
  assert.ok(out.actionId, "the create is an audited, undoable action");
});

test("update_trip joins, leaves ('none'), and undo restores", async () => {
  seed();
  addTrip("t-a", { journey_id: "11111111-1111-4111-8111-111111111111" });
  addTrip("t-b");
  const joined = await executeToolCall("update_trip", { trip_id: "t-b", same_journey_as: "t-a" });
  const b = db.trips.find((t) => t.id === "t-b")!;
  assert.equal(b.journey_id, "11111111-1111-4111-8111-111111111111");
  await undoExecutedAction(String(joined.actionId));
  assert.equal(b.journey_id, null, "undo takes it back out of the journey");
  await executeToolCall("update_trip", { trip_id: "t-b", journey_id: "11111111-1111-4111-8111-111111111111" });
  assert.equal(b.journey_id, "11111111-1111-4111-8111-111111111111");
  const left = await executeToolCall("update_trip", { trip_id: "t-b", journey_id: "none" });
  assert.equal(b.journey_id, null);
  await undoExecutedAction(String(left.actionId));
  assert.equal(b.journey_id, "11111111-1111-4111-8111-111111111111");
});

test("a journey that does not exist, or a trip that is not his, is refused", async () => {
  seed();
  addTrip("t-a");
  db.trips.push({ id: "t-theirs", user_id: "someone-else", journey_id: null, title: "x", purpose: "aica", work_stream_id: "ws-icai", cities: [] });
  await assert.rejects(() => executeToolCall("update_trip", { trip_id: "t-a", same_journey_as: "t-theirs" }), /not found/);
  await assert.rejects(() => executeToolCall("update_trip", { trip_id: "t-a", journey_id: "22222222-2222-4222-8222-222222222222" }), /No trip of his is on that journey_id/);
});

test("lifeos_list_trips returns journey_id", async () => {
  assert.match(src("lib/assistant/mcp-api.ts"), /journey_id: t\.journey_id/);
  assert.match(src("lib/assistant/mcp-api.ts"), /session_label, session_date, journey_id, work_streams\(name\)/);
});

test("the new parameters are single-typed strings, and the set still has no union", () => {
  for (const name of ["create_trip", "update_trip"]) {
    const props = toolByName(name)!.input_schema.properties as Record<string, { type: string; enum?: string[] }>;
    for (const p of ["same_journey_as", "journey_id"]) {
      assert.equal(props[p].type, "string", `${name}.${p}`);
      assert.equal(props[p].enum, undefined);
    }
    assert.ok(!((toolByName(name)!.input_schema.required ?? []) as string[]).some((r) => ["same_journey_as", "journey_id"].includes(r)));
  }
  assert.equal(schemaStats().unions, 0);
  assert.ok(MCP_READ_TOOLS.includes("lifeos_get_month_pack"));
});

test("there is still no journeys table, journey tool, delete tool or invoice", () => {
  assert.equal(toolByName("create_journey"), undefined);
  assert.equal(toolByName("list_journeys"), undefined);
  for (const f of ["lib/trips/write.ts", "lib/trips/journey.ts", "lib/trips/month.ts"]) {
    assert.doesNotMatch(src(f), /from\("journeys"\)|invoice_number|grand total/i, f);
  }
  const m = src("lib/trips/month.ts");
  assert.doesNotMatch(m.slice(m.indexOf("export function buildMonthPack")), /reduce\(|\.amount \+/, "the month pack sums nothing");
});

test("parseLegs is unchanged by the home city rule", () => {
  const raw = [{ from: "Ahmedabad", to: "Surat", date: "2026-10-08", mode: "cab", cost: 100 }];
  assert.equal(parseLegs(raw)[0].from, "Ahmedabad");
});
