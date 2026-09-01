// Offline proof for Milestone 6c (how the hotel is arranged). Run:
// npm run test:m6c (Node 22.18+, the same native TS type-stripping as the
// m3/m4/m5/m6/m6b suites). No network, no database: pure logic only.
//
// The point of the field is that it CHANGES WHAT THE APP ASKS OF HIM. These
// tests hold that: each of the four values produces a different checklist,
// and two of them produce no hotel step at all.
//
// What is proven:
//   1. branch, self, relative and same_day each produce the right steps and
//      the right dates.
//   2. same_day also drops the night-before line from the onward ticket.
//   3. A new trip defaults to branch whatever its purpose, and to same_day
//      when it starts and ends on one date.
//   4. A null column (every row written before this milestone) reads as
//      branch, never as a guess from the dates.
//   5. The tool surface carries hotel_arrangement as a single-typed optional
//      enum, the house rule the m4 suite also enforces.
//   6. The hard rules still tell the assistant the truth about hotels.

import test from "node:test";
import assert from "node:assert/strict";
import {
  HOTEL_ARRANGEMENTS,
  HOTEL_LABELS,
  HOTEL_SENTENCES,
  buildChecklist,
  defaultHotelArrangement,
  resolveHotelArrangement,
  type ChecklistTrip,
  type HotelArrangement,
} from "../lib/trips/checklist.ts";
import { TOOLS, toolByName } from "../lib/assistant/tools.ts";
import { HARD_RULES } from "../lib/assistant/prompt.ts";

const TODAY = "2026-08-01";

const TRIP: ChecklistTrip = {
  title: "AICA session, Rajkot branch",
  purpose: "aica",
  start_date: "2026-09-03",
  end_date: "2026-09-04",
  bills_to: "icai_monthly",
  cities: ["Rajkot"],
};

function keys(hotel: HotelArrangement): string[] {
  return buildChecklist({ ...TRIP, hotel_arrangement: hotel }, TODAY).map(
    (s) => s.key
  );
}

function step(hotel: HotelArrangement, key: string) {
  return buildChecklist({ ...TRIP, hotel_arrangement: hotel }, TODAY).find(
    (s) => s.key === key
  );
}

// --- 1. each value produces a different checklist ---------------------------

test("branch asks him to confirm, five days out", () => {
  const hotel = step("branch", "hotel")!;
  assert.equal(hotel.title, "Confirm hotel with the branch");
  assert.equal(hotel.due_date, "2026-08-29"); // 5 days before the start
  assert.match(hotel.note, /confirmation, not a booking/);
});

test("self asks him to book, seven days out with the tickets", () => {
  const hotel = step("self", "hotel")!;
  assert.equal(hotel.title, "Book hotel");
  assert.equal(hotel.due_date, "2026-08-27"); // 7 days before, like the tickets
  assert.equal(hotel.due_date, step("self", "onward")!.due_date);
  // The trip title itself names a branch, so the check is on the wording the
  // branch arrangement adds, not on the word.
  assert.ok(
    !/arranges the hotel/.test(hotel.note),
    "his own booking, not the branch's"
  );
  assert.match(hotel.note, /billable expense/);
});

test("staying with family produces no hotel step at all", () => {
  assert.deepEqual(keys("relative"), ["onward", "return", "receipts"]);
});

test("a day return produces no hotel step at all", () => {
  assert.deepEqual(keys("same_day"), ["onward", "return", "receipts"]);
});

test("the four values differ from one another, which is the whole point", () => {
  const shapes = HOTEL_ARRANGEMENTS.map((h) =>
    JSON.stringify(buildChecklist({ ...TRIP, hotel_arrangement: h }, TODAY))
  );
  assert.equal(new Set(shapes).size, 4, "no two arrangements ask the same thing");
});

test("only the hotel step moves: the other steps are untouched", () => {
  for (const h of HOTEL_ARRANGEMENTS) {
    assert.equal(step(h, "return")!.due_date, "2026-08-27");
    assert.equal(step(h, "receipts")!.due_date, "2026-09-04");
    // No bill step to check: since M6d nothing per trip raises an invoice.
  }
});

// --- 2. the night before ----------------------------------------------------

test("same_day drops the night-before line from the onward ticket", () => {
  assert.ok(!/night before/.test(step("same_day", "onward")!.note));
  assert.match(step("same_day", "onward")!.note, /Back the same day/);
});

test("every other arrangement keeps the night-before line", () => {
  for (const h of ["branch", "self", "relative"] as HotelArrangement[]) {
    assert.match(step(h, "onward")!.note, /Arrive the night before/);
  }
});

// --- 3. the default ---------------------------------------------------------

test("every work trip defaults to branch, whatever its purpose", () => {
  // The branch arranges his hotel on almost every work trip. Industry batches
  // at company sites are the exception he sets by hand, and they have no
  // purpose of their own, so purpose may never be used to guess "industry".
  for (const p of ["aica", "conference", "other"] as const) {
    assert.equal(defaultHotelArrangement("2026-09-03", "2026-09-04", p), "branch", p);
  }
  assert.equal(defaultHotelArrangement("2026-09-03", "2026-09-04"), "branch");
  assert.equal(defaultHotelArrangement(null, "2026-09-04"), "branch");
  assert.equal(defaultHotelArrangement("2026-09-03", null), "branch");
  assert.equal(defaultHotelArrangement(null, null), "branch");
});

test("leisure is the one purpose that defaults to booking it himself", () => {
  // Nobody arranges a hotel for his holiday. This is the single exception to
  // the branch default, added 1 September 2026 after it read as nonsense on a
  // leisure trip; it must not spread to any other purpose.
  assert.equal(defaultHotelArrangement("2026-12-20", "2026-12-27", "leisure"), "self");
  // A leisure day trip is still a day return: the dates win over the purpose.
  assert.equal(defaultHotelArrangement("2026-12-20", "2026-12-20", "leisure"), "same_day");
});

test("a trip that starts and ends on one date defaults to same_day", () => {
  assert.equal(defaultHotelArrangement("2026-09-03", "2026-09-03"), "same_day");
});

test("one date apart is not a day return", () => {
  assert.equal(defaultHotelArrangement("2026-09-03", "2026-09-04"), "branch");
});

// --- 4. reading the rows that came before -----------------------------------

test("a null column reads as branch, the norm, for any purpose", () => {
  // The signature takes no purpose at all, so a whole-trip object with any
  // purpose on it resolves the same way. That is the guarantee.
  for (const purpose of ["aica", "conference", "leisure", "other"]) {
    const trip = { ...TRIP, purpose, hotel_arrangement: null };
    assert.equal(resolveHotelArrangement(trip), "branch");
    assert.equal(buildChecklist(trip, TODAY).find((s) => s.key === "hotel")!.title,
      "Confirm hotel with the branch");
  }
  assert.equal(resolveHotelArrangement({}), "branch");
});

test("a null column is never read from the dates", () => {
  // A same-dates trip written before this milestone still reads as branch:
  // defaulting a NEW trip and reading an OLD one are different questions.
  const sameDates = { ...TRIP, end_date: TRIP.start_date, hotel_arrangement: null };
  assert.equal(resolveHotelArrangement(sameDates), "branch");
  assert.ok(buildChecklist(sameDates, TODAY).some((s) => s.key === "hotel"));
});

test("a stored value always beats the default", () => {
  assert.equal(resolveHotelArrangement({ hotel_arrangement: "self" }), "self");
  assert.equal(
    resolveHotelArrangement({ ...TRIP, hotel_arrangement: "self" }),
    "self"
  );
});

test("a trip with no start date still offers no checklist", () => {
  for (const h of HOTEL_ARRANGEMENTS) {
    assert.deepEqual(
      buildChecklist({ ...TRIP, start_date: null, hotel_arrangement: h }, TODAY),
      []
    );
  }
});

test("no step is ever dated in the past, whatever the arrangement", () => {
  for (const h of HOTEL_ARRANGEMENTS) {
    const steps = buildChecklist({ ...TRIP, hotel_arrangement: h }, "2026-12-25");
    assert.ok(steps.every((s) => s.due_date >= "2026-12-25"));
  }
});

// --- 5. the tool surface ----------------------------------------------------

test("create_trip and update_trip take hotel_arrangement, optional and single-typed", () => {
  for (const name of ["create_trip", "update_trip"]) {
    const tool = toolByName(name)!;
    const props = tool.input_schema.properties as Record<
      string,
      { type: string; enum?: string[] }
    >;
    const prop = props.hotel_arrangement;
    assert.equal(prop.type, "string", `${name} takes one concrete type`);
    assert.deepEqual(prop.enum, ["branch", "self", "relative", "same_day"]);
    assert.ok(
      !((tool.input_schema.required ?? []) as string[]).includes("hotel_arrangement"),
      `${name} leaves hotel_arrangement optional`
    );
  }
});

test("the new parameter keeps the one-concrete-type rule across the whole set", () => {
  const walk = (n: unknown): void => {
    if (!n || typeof n !== "object") return;
    if (Array.isArray(n)) return n.forEach(walk);
    const o = n as Record<string, unknown>;
    assert.ok(!Array.isArray(o.type), "no union types");
    assert.ok(!o.anyOf && !o.oneOf, "no anyOf/oneOf");
    Object.values(o).forEach(walk);
  };
  for (const t of TOOLS) walk(t.input_schema);
});

test("nothing new can approve, book or pay for anything", () => {
  const names = TOOLS.map((t) => t.name);
  assert.ok(!names.some((k) => /approve|book_hotel|reserve|pay/i.test(k)));
  assert.equal(toolByName("update_trip")!.bucket, "autonomous");
});

// --- 6. the hard rules tell the truth ---------------------------------------

test("the hard rules no longer refuse hotel help outright", () => {
  assert.ok(
    !/do not offer to book or track hotels for AICA trips/.test(HARD_RULES),
    "the old blanket refusal is gone"
  );
  assert.match(HARD_RULES, /Industry batches/);
  assert.match(HARD_RULES, /returning the same day/);
  assert.match(HARD_RULES, /night before/);
});

// --- copy -------------------------------------------------------------------

test("every arrangement has a label and a plain sentence for the trip screen", () => {
  const dashes = /[—–]/;
  for (const h of HOTEL_ARRANGEMENTS) {
    assert.ok(HOTEL_LABELS[h]?.length, `${h} has a label`);
    assert.ok(HOTEL_SENTENCES[h]?.length, `${h} has a sentence`);
    assert.ok(!dashes.test(HOTEL_SENTENCES[h]), "no em-dashes in UI copy");
  }
});
