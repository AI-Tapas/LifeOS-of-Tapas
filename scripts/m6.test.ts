// Offline proof for Milestone 6 (Travel Desk). Run: npm run test:m6
// (Node 22.18+, the same native TS type-stripping as the m3/m4/m5 suites.)
// No network, no database: everything proven here is pure logic.
//
// What is proven:
//   1. Bill line items derive from billable expenses only, grouped by
//      category in a fixed order, and the total matches the rollup.
//   2. Money reads as Indian: digit grouping and the amount in words in
//      lakhs and crores, including zero, exact boundaries and paise.
//   3. Bill numbers run sequentially inside the Indian financial year, so a
//      March bill and an April bill land in different years.
//   4. The jsonb columns (legs, line_items) are read defensively.
//   5. The registry rule that no tool can send a bill or move its status:
//      create_bill_draft is the only bill tool and it drafts.

import test from "node:test";
import assert from "node:assert/strict";
import {
  CATEGORY_LABELS,
  EXPENSE_CATEGORIES,
  TRANSPORT_MODES,
  amountInWordsIndian,
  billableTotal,
  deriveLineItems,
  financialYearLabel,
  lineItemsTotal,
  nextBillNumber,
  numberInWordsIndian,
  parseLegs,
  parseLineItems,
  type BillableExpense,
} from "../lib/trips/bill.ts";
import { formatINR } from "../lib/datetime.ts";
import { TOOLS, AUTONOMOUS_KINDS, STUB_KINDS, toolByName } from "../lib/assistant/tools.ts";

function expense(over: Partial<BillableExpense> & { id: string }): BillableExpense {
  return {
    category: "transport",
    amount: 100,
    date: "2026-05-17",
    billable: true,
    ...over,
  };
}

// --- 1. line items and the billable rollup -----------------------------------

const TRIP_EXPENSES: BillableExpense[] = [
  expense({ id: "a", category: "transport", amount: 1240, date: "2026-05-17" }),
  expense({ id: "b", category: "transport", amount: 1310, date: "2026-05-19" }),
  expense({ id: "c", category: "per_diem", amount: 800, date: "2026-05-18" }),
  expense({ id: "d", category: "hotel", amount: 3200, date: "2026-05-17" }),
  // his own cost: never on a bill
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

test("line items group by category, in the fixed category order", () => {
  const items = deriveLineItems(TRIP_EXPENSES);
  assert.equal(items.length, 3, "transport, hotel, per diem; the own-cost row is dropped");
  assert.deepEqual(
    items.map((i) => i.description.split(",")[0]),
    [CATEGORY_LABELS.transport, CATEGORY_LABELS.hotel, CATEGORY_LABELS.per_diem]
  );
  // The transport line carries both fares and the earliest of their dates.
  assert.equal(items[0].amount, 2550);
  assert.equal(items[0].date, "2026-05-17");
  assert.match(items[0].description, /2 expenses/);
  assert.match(items[0].description, /17 May 2026 to 19 May 2026/);
  // A single-expense group names one date, not a span.
  assert.match(items[1].description, /1 expense, 17 May 2026$/);
});

test("the bill total equals the billable rollup", () => {
  assert.equal(lineItemsTotal(deriveLineItems(TRIP_EXPENSES)), billableTotal(TRIP_EXPENSES));
});

test("a trip with nothing billable derives no lines at all", () => {
  assert.deepEqual(deriveLineItems([expense({ id: "x", billable: false })]), []);
});

test("paise survive the rollup without float drift", () => {
  const items = deriveLineItems([
    expense({ id: "p1", amount: 10.1 }),
    expense({ id: "p2", amount: 20.2 }),
  ]);
  assert.equal(items[0].amount, 30.3);
  assert.equal(billableTotal([expense({ id: "p1", amount: 0.1 }), expense({ id: "p2", amount: 0.2 })]), 0.3);
});

// --- 2. Indian money ---------------------------------------------------------

test("digit grouping is Indian, not international", () => {
  assert.equal(formatINR(12000000), "₹ 1,20,00,000");
  assert.equal(formatINR(100000), "₹ 1,00,000");
  assert.equal(formatINR(6550), "₹ 6,550");
  assert.equal(formatINR(1234.5), "₹ 1,234.50");
});

test("amount in words uses lakhs and crores", () => {
  assert.equal(amountInWordsIndian(0), "Rupees Zero only");
  assert.equal(amountInWordsIndian(6550), "Rupees Six Thousand Five Hundred Fifty only");
  assert.equal(amountInWordsIndian(100000), "Rupees One Lakh only");
  assert.equal(amountInWordsIndian(10000000), "Rupees One Crore only");
  assert.equal(amountInWordsIndian(12000000), "Rupees One Crore Twenty Lakh only");
  assert.equal(
    amountInWordsIndian(99999),
    "Rupees Ninety Nine Thousand Nine Hundred Ninety Nine only"
  );
  assert.equal(amountInWordsIndian(120000), "Rupees One Lakh Twenty Thousand only");
});

test("amount in words names paise only when there are any", () => {
  assert.equal(amountInWordsIndian(1234), "Rupees One Thousand Two Hundred Thirty Four only");
  assert.equal(
    amountInWordsIndian(1234.5),
    "Rupees One Thousand Two Hundred Thirty Four and Fifty Paise only"
  );
  // Rounding must not leave "one hundred paise" behind.
  assert.equal(amountInWordsIndian(99.999), "Rupees One Hundred only");
});

test("words carry past one hundred crore", () => {
  assert.equal(numberInWordsIndian(1200000000), "One Hundred Twenty Crore");
});

// --- 3. financial-year bill numbering ----------------------------------------

test("the financial year runs April to March", () => {
  assert.equal(financialYearLabel("2026-04-01"), "2026-27");
  assert.equal(financialYearLabel("2027-03-31"), "2026-27");
  assert.equal(financialYearLabel("2026-03-31"), "2025-26");
  assert.equal(financialYearLabel("2026-12-15"), "2026-27");
});

test("numbering restarts in April and ignores other years' numbers", () => {
  const existing = ["AICA/2025-26/001", "AICA/2025-26/002"];
  // A March bill continues the old year's series...
  assert.equal(nextBillNumber("AICA", "2026-03-31", existing), "AICA/2025-26/003");
  // ...and an April bill starts the new one at 001.
  assert.equal(nextBillNumber("AICA", "2026-04-01", existing), "AICA/2026-27/001");
});

test("numbering takes the highest existing serial, not the count", () => {
  assert.equal(
    nextBillNumber("AICA", "2026-05-17", ["AICA/2026-27/001", "AICA/2026-27/009"]),
    "AICA/2026-27/010"
  );
  assert.equal(nextBillNumber("AICA", "2026-05-17", []), "AICA/2026-27/001");
  // Another series is not this one.
  assert.equal(
    nextBillNumber("AICA", "2026-05-17", ["TS/2026-27/007"]),
    "AICA/2026-27/001"
  );
});

// --- 4. defensive jsonb reads ------------------------------------------------

test("legs and line items survive whatever the jsonb column holds", () => {
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

  assert.deepEqual(parseLineItems(undefined), []);
  const items = parseLineItems([{ date: "2026-05-17", description: "Transport", amount: 10 }]);
  assert.equal(items[0].amount, 10);
});

test("the transport modes are listed in his preference order", () => {
  assert.deepEqual(TRANSPORT_MODES.slice(0, 4), [
    "vande_bharat",
    "tejas",
    "ac_sleeper",
    "cab",
  ]);
  assert.deepEqual(EXPENSE_CATEGORIES, ["transport", "hotel", "per_diem", "other"]);
});

// --- 5. the bill can only ever be a draft ------------------------------------

test("no tool sends a bill or moves its status", () => {
  const billTools = TOOLS.filter((t) => /bill/i.test(t.name));
  assert.deepEqual(
    billTools.map((t) => t.name),
    ["create_bill_draft"],
    "create_bill_draft is the only bill tool there is"
  );
  for (const t of TOOLS) {
    assert.doesNotMatch(
      t.name,
      /send_bill|mark_bill|bill_status|submit_bill/i,
      `tool ${t.name} looks like it could send or settle a bill`
    );
  }
  assert.match(toolByName("create_bill_draft")!.description, /draft/i);
});

test("the travel desk tools are real, autonomous and no longer stubs", () => {
  for (const name of [
    "create_trip",
    "update_trip",
    "log_trip_leg",
    "add_trip_expense",
    "create_bill_draft",
  ]) {
    assert.equal(STUB_KINDS.has(name), false, `${name} must not be a stub any more`);
    assert.equal(AUTONOMOUS_KINDS.has(name), true, `${name} should be autonomous`);
  }
});

test("nothing in the travel desk invites a document", () => {
  // Confidential boundary: receipt_ref and pdf_ref are reference strings, so
  // no tool may take a file, an upload or a document body.
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
