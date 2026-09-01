// Offline proof for the Travel Desk, as it stands after M6d. Run:
// npm run test:m6 (Node 22.18+, the same native TS type-stripping as the
// m3/m4/m5/m6b suites.) No network, no database: everything proven here is
// pure logic.
//
// M6d removed the per-trip bill builder. What used to be proven about bill
// numbering, bill line items and amount-in-words is gone with the code; what
// replaces it is proven below.
//
// What is proven:
//   1. The billable rollup counts billable expenses only, without float drift.
//   2. Money reads as Indian (digit grouping), and the jsonb columns are read
//      defensively.
//   3. The month pack: which trips a month holds (IST month boundary), what
//      the ICAI claim excludes, and the receipt gaps.
//   4. The clipboard text carries the records and no invoice arithmetic.
//   5. The receipt-gap line runs from the 25th only.
//   6. The removals hold: no bill tool in the registry, none on the connector
//      read surface, and nothing that could send or settle a bill.

import test from "node:test";
import assert from "node:assert/strict";
import {
  CATEGORY_LABELS,
  EXPENSE_CATEGORIES,
  TRANSPORT_MODES,
  billableTotal,
  parseLegs,
  type BillableExpense,
} from "../lib/trips/bill.ts";
import {
  briefGapLine,
  buildMonthPack,
  currentAndPreviousMonths,
  monthLabel,
  monthPackText,
  previousMonthKey,
  receiptGaps,
  shiftMonth,
  tripMonthKey,
  type MonthExpense,
  type MonthTrip,
} from "../lib/trips/month.ts";
import { formatINR } from "../lib/datetime.ts";
import {
  TOOLS,
  AUTONOMOUS_KINDS,
  MCP_READ_TOOLS,
  STUB_KINDS,
  toolByName,
} from "../lib/assistant/tools.ts";

function expense(over: Partial<BillableExpense> & { id: string }): BillableExpense {
  return {
    category: "transport",
    amount: 100,
    date: "2026-05-17",
    billable: true,
    ...over,
  };
}

// --- 1. the billable rollup --------------------------------------------------

const TRIP_EXPENSES: BillableExpense[] = [
  expense({ id: "a", category: "transport", amount: 1240, date: "2026-05-17" }),
  expense({ id: "b", category: "transport", amount: 1310, date: "2026-05-19" }),
  expense({ id: "c", category: "per_diem", amount: 800, date: "2026-05-18" }),
  expense({ id: "d", category: "hotel", amount: 3200, date: "2026-05-17" }),
  // his own cost: never claimed
  expense({ id: "e", category: "other", amount: 450, date: "2026-05-18", billable: false }),
];

test("only billable expenses count towards the trip total", () => {
  assert.equal(billableTotal(TRIP_EXPENSES), 6550);
  assert.equal(billableTotal([]), 0);
  assert.equal(
    billableTotal(TRIP_EXPENSES.filter((e) => !e.billable)),
    0,
    "a trip of own-cost expenses claims nothing"
  );
});

test("paise survive the rollup without float drift", () => {
  assert.equal(
    billableTotal([
      expense({ id: "p1", amount: 0.1 }),
      expense({ id: "p2", amount: 0.2 }),
    ]),
    0.3
  );
});

// --- 2. Indian money and defensive jsonb -------------------------------------

test("digit grouping is Indian, not international", () => {
  assert.equal(formatINR(12000000), "₹ 1,20,00,000");
  assert.equal(formatINR(100000), "₹ 1,00,000");
  assert.equal(formatINR(6550), "₹ 6,550");
  assert.equal(formatINR(1234.5), "₹ 1,234.50");
});

test("legs survive whatever the jsonb column holds", () => {
  assert.deepEqual(parseLegs(null), []);
  assert.deepEqual(parseLegs("not an array"), []);
  const legs = parseLegs([
    { from: "Rajkot", to: "Ahmedabad", date: "2026-05-19", mode: "tejas", cost: 900 },
    { from: "Ahmedabad", to: "Rajkot", date: "2026-05-17", mode: "made_up" },
    { nonsense: true },
  ]);
  assert.equal(legs.length, 2, "the shapeless entry is dropped, not thrown on");
  assert.equal(legs[0].date, "2026-05-17", "legs come back in date order");
  assert.equal(legs[0].mode, "other", "an unknown mode falls back rather than breaking");
  assert.equal(legs[0].cost, null);
});

test("the transport modes and expense categories keep his order", () => {
  assert.deepEqual(TRANSPORT_MODES.slice(0, 4), [
    "vande_bharat",
    "tejas",
    "ac_sleeper",
    "cab",
  ]);
  assert.deepEqual(EXPENSE_CATEGORIES, ["transport", "hotel", "per_diem", "other"]);
  assert.equal(CATEGORY_LABELS.per_diem, "Per diem");
});

// --- 3. the month pack -------------------------------------------------------

const BHAVNAGAR: MonthTrip = {
  id: "t1",
  title: "AICA session, Bhavnagar branch",
  start_date: "2026-08-17",
  end_date: "2026-08-19",
  cities: ["Bhavnagar"],
  bills_to: "icai_monthly",
  legs: [
    { from: "Ahmedabad", to: "Bhavnagar", date: "2026-08-17", mode: "vande_bharat", cost: 1240 },
    { from: "Bhavnagar", to: "Ahmedabad", date: "2026-08-19", mode: "tejas", cost: 1310 },
  ],
};

// The boundary case: a session that ends on 31 August at 11 pm IST. Dates are
// stored as bare IST calendar dates, so this row reads 2026-08-31 and belongs
// to August, not September.
const LATE_AUGUST: MonthTrip = {
  id: "t2",
  title: "AICA session, Rajkot branch",
  start_date: "2026-08-30",
  end_date: "2026-08-31",
  cities: ["Rajkot"],
  bills_to: "icai_monthly",
  legs: [],
};

const DUBAI: MonthTrip = {
  id: "t3",
  title: "AICA session, Dubai chapter",
  start_date: "2026-08-24",
  end_date: "2026-08-25",
  cities: ["Dubai"],
  bills_to: "chapter_aed",
  legs: [
    { from: "Ahmedabad", to: "Dubai", date: "2026-08-24", mode: "flight", cost: 24000 },
  ],
};

const FAMILY: MonthTrip = {
  id: "t4",
  title: "Family trip",
  start_date: "2026-08-08",
  end_date: "2026-08-10",
  cities: ["Mount Abu"],
  bills_to: "none",
  legs: [],
};

const SEPTEMBER: MonthTrip = {
  id: "t5",
  title: "AICA session, Surat branch",
  start_date: "2026-09-01",
  end_date: "2026-09-02",
  cities: ["Surat"],
  bills_to: "icai_monthly",
  legs: [],
};

const TRIPS = [BHAVNAGAR, LATE_AUGUST, DUBAI, FAMILY, SEPTEMBER];

function mExpense(over: Partial<MonthExpense> & { id: string; trip_id: string }): MonthExpense {
  return {
    category: "transport",
    amount: 100,
    date: "2026-08-17",
    billable: true,
    receipt_ref: "physical file",
    ...over,
  };
}

const EXPENSES: MonthExpense[] = [
  mExpense({ id: "x1", trip_id: "t1", amount: 1240, date: "2026-08-17" }),
  // billable with no reference: a gap
  mExpense({ id: "x2", trip_id: "t1", amount: 1310, date: "2026-08-19", receipt_ref: null }),
  mExpense({ id: "x3", trip_id: "t1", category: "hotel", amount: 3200, date: "2026-08-18", receipt_ref: "  " }),
  // not billable, so not a gap even without a reference
  mExpense({ id: "x4", trip_id: "t1", category: "other", amount: 450, billable: false, receipt_ref: null }),
  // on the excluded Dubai trip, so never a gap on the ICAI claim
  mExpense({ id: "x5", trip_id: "t3", amount: 24000, date: "2026-08-24", receipt_ref: null }),
  // next month
  mExpense({ id: "x6", trip_id: "t5", amount: 900, date: "2026-09-01", receipt_ref: null }),
];

test("a trip belongs to the month it finishes in, in IST", () => {
  // 31 August at 11 pm IST is stored as 2026-08-31: August, not September.
  assert.equal(tripMonthKey(LATE_AUGUST), "2026-08");
  assert.equal(tripMonthKey(SEPTEMBER), "2026-09");
  // A trip spanning the boundary counts in the month it ends.
  assert.equal(
    tripMonthKey({ start_date: "2026-08-31", end_date: "2026-09-01" }),
    "2026-09"
  );
  // No end date falls back to the start.
  assert.equal(tripMonthKey({ start_date: "2026-08-05", end_date: null }), "2026-08");
  assert.equal(tripMonthKey({ start_date: null, end_date: null }), "");
});

test("the pack defaults to the month just gone", () => {
  assert.equal(previousMonthKey("2026-09-01"), "2026-08");
  assert.equal(previousMonthKey("2026-01-15"), "2025-12");
  assert.equal(shiftMonth("2026-12", 1), "2027-01");
  assert.equal(monthLabel("2026-08"), "August 2026");
});

test("the month pack holds August's ICAI sessions and nothing else", () => {
  const pack = buildMonthPack(TRIPS, EXPENSES, "2026-08");
  assert.deepEqual(
    pack.sessions.map((s) => s.trip_id),
    ["t1", "t2"],
    "Bhavnagar and the 31 August session; Dubai, the family trip and September are out"
  );
  assert.equal(pack.sessions[0].dates, "17 to 19 August 2026");
  assert.deepEqual(pack.sessions[0].cities, ["Bhavnagar"]);
});

test("a chapter_aed trip is excluded from the claim and says why", () => {
  const pack = buildMonthPack(TRIPS, EXPENSES, "2026-08");
  const dubai = pack.excluded.find((x) => x.trip_id === "t3");
  assert.ok(dubai, "the Dubai trip is listed, not silently dropped");
  assert.equal(dubai!.bills_to, "chapter_aed");
  assert.match(dubai!.reason, /AED/);
  assert.match(dubai!.reason, /Not on the ICAI claim/);
  // And it is nowhere in the claimed sections.
  assert.ok(!pack.sessions.some((s) => s.trip_id === "t3"));
  assert.ok(!pack.legs.some((l) => l.trip_id === "t3"));
  assert.ok(!pack.expense_groups.some((g) => g.trip_id === "t3"));
  assert.ok(!pack.gaps.some((e) => e.trip_id === "t3"));
});

test("a 'none' trip is excluded too, and named", () => {
  const pack = buildMonthPack(TRIPS, EXPENSES, "2026-08");
  const family = pack.excluded.find((x) => x.trip_id === "t4");
  assert.ok(family);
  assert.equal(family!.bills_to, "none");
  assert.match(family!.reason, /Not billable/);
});

test("legs come out in date order across the month's trips", () => {
  const pack = buildMonthPack(TRIPS, EXPENSES, "2026-08");
  assert.deepEqual(
    pack.legs.map((l) => l.date),
    ["2026-08-17", "2026-08-19"]
  );
  assert.equal(pack.legs[0].from, "Ahmedabad");
});

test("expenses group by trip, and a trip with none does not appear", () => {
  const pack = buildMonthPack(TRIPS, EXPENSES, "2026-08");
  assert.deepEqual(pack.expense_groups.map((g) => g.trip_id), ["t1"]);
  assert.deepEqual(
    pack.expense_groups[0].expenses.map((e) => e.id),
    ["x1", "x4", "x3", "x2"],
    "in date order, own-cost rows included and marked rather than hidden"
  );
});

test("the gaps are the billable claimed expenses with no reference", () => {
  const pack = buildMonthPack(TRIPS, EXPENSES, "2026-08");
  assert.deepEqual(pack.gaps.map((e) => e.id), ["x3", "x2"]);
  // x4 is not billable, x5 is on the excluded Dubai trip.
  assert.ok(!pack.gaps.some((e) => e.id === "x4" || e.id === "x5"));
});

test("whitespace is not a receipt reference", () => {
  assert.deepEqual(
    receiptGaps(EXPENSES, ["2026-08"]).map((e) => e.id),
    ["x3", "x2", "x5"],
    "the blank-string reference counts as missing"
  );
});

test("the standing line covers the month running and the one before it", () => {
  assert.deepEqual(currentAndPreviousMonths("2026-09-14"), ["2026-09", "2026-08"]);
  assert.deepEqual(currentAndPreviousMonths("2026-01-03"), ["2026-01", "2025-12"]);
});

// --- 4. the clipboard text ---------------------------------------------------

test("the copied text carries the records and refuses to do the arithmetic", () => {
  const text = monthPackText(buildMonthPack(TRIPS, EXPENSES, "2026-08"));
  assert.match(text, /Life OS month pack: August 2026/);
  assert.match(text, /SESSIONS/);
  assert.match(text, /Bhavnagar/);
  assert.match(text, /TRAVEL LEGS/);
  assert.match(text, /EXCLUDED FROM THIS CLAIM/);
  assert.match(text, /Dubai/);
  assert.match(text, /GAPS/);
  assert.match(text, /1\. 18 August 2026/);
  assert.match(text, /no receipt on file/);
  // Nothing that could be mistaken for a claim or an invoice.
  assert.doesNotMatch(text, /TOTAL|Total:|Invoice number|TR-\d{4}|Rupees /);
});

test("an empty month still produces a readable pack", () => {
  const text = monthPackText(buildMonthPack([], [], "2026-07"));
  assert.match(text, /July 2026/);
  assert.match(text, /None\. Every billable expense has a reference\./);
});

// --- 5. the brief's gap line -------------------------------------------------

test("the gap line stays quiet until the 25th", () => {
  assert.equal(briefGapLine(EXPENSES, "2026-08-24"), null);
  const line = briefGapLine(EXPENSES, "2026-08-25");
  assert.ok(line, "on the 25th it speaks");
  assert.match(line!, /^3 billable expenses have no receipt reference/);
});

test("the gap line says nothing when there is nothing missing", () => {
  const clean = EXPENSES.map((e) => ({ ...e, receipt_ref: "physical file" }));
  assert.equal(briefGapLine(clean, "2026-08-31"), null);
});

test("one gap reads as one", () => {
  const one = [mExpense({ id: "g", trip_id: "t1", date: "2026-08-02", receipt_ref: null })];
  assert.match(briefGapLine(one, "2026-08-28")!, /^1 billable expense has/);
});

// --- 6. the removals ---------------------------------------------------------

test("no tool in the registry bills, sends a bill or settles one", () => {
  for (const t of TOOLS) {
    assert.doesNotMatch(
      t.name,
      /bill|invoice/i,
      `tool ${t.name} looks like it bills; M6d removed that from this app`
    );
  }
  assert.equal(toolByName("create_bill_draft"), undefined);
});

test("lifeos_list_bills is off the connector read surface", () => {
  assert.ok(!(MCP_READ_TOOLS as readonly string[]).includes("lifeos_list_bills"));
  for (const name of MCP_READ_TOOLS) {
    assert.doesNotMatch(name, /bill|invoice/i, `${name} still reads bills`);
  }
});

test("the travel desk tools that remain are real, autonomous and undoable", () => {
  for (const name of ["create_trip", "update_trip", "log_trip_leg", "add_trip_expense"]) {
    assert.equal(STUB_KINDS.has(name), false, `${name} must not be a stub`);
    assert.equal(AUTONOMOUS_KINDS.has(name), true, `${name} should be autonomous`);
  }
});

test("bills_to is an enum on the trip tools, not free text", () => {
  for (const name of ["create_trip", "update_trip"]) {
    const props = toolByName(name)!.input_schema.properties as Record<
      string,
      { type: string; enum?: string[] }
    >;
    assert.deepEqual(props.bills_to.enum, ["icai_monthly", "chapter_aed", "none"]);
    assert.equal(props.bills_to.type, "string");
    assert.ok(
      !((toolByName(name)!.input_schema.required ?? []) as string[]).includes("bills_to"),
      `${name}'s bills_to is optional, so the default stands`
    );
    assert.equal(
      props.billable_to,
      undefined,
      `${name} must not carry the old free-text payer`
    );
  }
});

test("nothing in the travel desk invites a document", () => {
  // Confidential boundary: receipt_ref is a reference string, so no tool may
  // take a file, an upload or a document body.
  for (const t of TOOLS) {
    const props = Object.keys(
      (t.input_schema as { properties?: Record<string, unknown> }).properties ?? {}
    );
    for (const p of props) {
      assert.doesNotMatch(
        p,
        /^(file|upload|attachment|document|content|base64)/i,
        `${t.name}.${p} looks like a document field`
      );
    }
  }
  assert.match(
    JSON.stringify(toolByName("add_trip_expense")!.input_schema),
    /Never the document itself/,
    "the receipt field must say plainly that it is a reference, not a file"
  );
});
