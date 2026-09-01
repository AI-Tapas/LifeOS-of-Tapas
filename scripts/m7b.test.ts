// Offline proof for M7b (money completed). Run: npm run test:m7b.
// Node 22.18+, native TS type-stripping, the same pattern as the m3, m4, m5,
// m6, m6b, m6c, b3 and m7a suites. No network, no database.
//
// What is proven:
//   1. A maturity interrupts him on the calendar; a review date never does,
//      and switching one to the other removes the event it had.
//   2. The next maturity and the next review are chosen on the IST calendar
//      day, so a date stops being "next" when IST rolls over, not when UTC
//      does.
//   3. Money reads as Indian, on real figures including a crore.
//   4. A sub-monthly obligation series produces the right next three dates,
//      and the RRULE Google expands agrees with the dates he is shown.
//   5. The work-stream rate reaches the assistant's context.
//   6. No investment field and no tool parameter accepts an account number, a
//      folio number or a file. Same guard as scripts/m6.test.ts, aimed at the
//      module that invites the breach hardest.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  civilDateKey,
  customStepDays,
  financeReminderMode,
  isFinanceKeyDateType,
  nextObligationDates,
  obligationSeriesRRule,
  parseDateKey,
  planFinanceReminder,
  type ObligationSeries,
} from "../lib/reminders/core.ts";
import {
  KIND_LABELS,
  defaultKeyDateType,
  nextMaturity,
  nextReview,
  remindsOnCalendar,
  reviewHorizonKey,
  reviewLine,
  reviewsDue,
  totalValue,
  totalsByKind,
  type Holding,
} from "../lib/money/investments.ts";
import { RATE_FLOOR, streamRateLine } from "../lib/money/rates.ts";
import { civilToday, formatINR } from "../lib/datetime.ts";
import { TOOLS, toolByName } from "../lib/assistant/tools.ts";
import { HARD_RULES } from "../lib/assistant/prompt.ts";

const src = (rel: string): string =>
  readFileSync(new URL("../" + rel, import.meta.url), "utf8");

function holding(over: Partial<Holding> & { id: string }): Holding {
  return {
    kind: "fd",
    name: "A holding",
    institution: null,
    value: null,
    key_date: null,
    key_date_type: null,
    remind: true,
    notes: null,
    ...over,
  };
}

// --- 1. which reminder an investment gets ----------------------------------

test("a maturity is a calendar interrupt and a review date is not", () => {
  assert.equal(financeReminderMode("maturity"), "calendar");
  assert.equal(financeReminderMode("review"), "in_app");
  // A holding with no date type at all is not a deadline, so it is treated
  // as the quiet case rather than being given a calendar entry by default.
  assert.equal(financeReminderMode(null), "in_app");
});

test("only a dated maturity he wants reminding about writes an event", () => {
  const maturity = { key_date: "2026-12-01", key_date_type: "maturity" as const, remind: true };
  assert.equal(planFinanceReminder(maturity), "write");
  // Same holding, review date: nothing on the calendar.
  assert.equal(
    planFinanceReminder({ ...maturity, key_date_type: "review" }),
    "remove"
  );
  // No date, or reminders switched off: nothing either.
  assert.equal(planFinanceReminder({ ...maturity, key_date: null }), "remove");
  assert.equal(planFinanceReminder({ ...maturity, remind: false }), "remove");
});

test("switching a maturity to a review takes the same removal path", () => {
  // One decision function covers both directions, so there is no second
  // cleanup route that could leave an orphan event on his calendar. This is
  // the m7a rule for tasks, applied to holdings.
  const writer = src("lib/reminders/writer.ts");
  assert.match(writer, /planFinanceReminder\(state\) === "remove"/);
  assert.match(
    writer,
    /removeReminder\(svc, userId, \{ finance_item_id: financeItemId \}\)/
  );
  // And it is the same writeReminder every other reminder goes through: no
  // second calendar path was built for money.
  assert.equal(
    (writer.match(/async function gcalCreate/g) ?? []).length,
    1,
    "there must still be exactly one event-creating function"
  );
});

test("the executor validates the key date type instead of trusting the wire", () => {
  assert.ok(isFinanceKeyDateType("maturity"));
  assert.ok(isFinanceKeyDateType("review"));
  assert.ok(!isFinanceKeyDateType("MATURITY"));
  assert.ok(!isFinanceKeyDateType("calendar"));
  assert.match(
    src("lib/assistant/execute.ts"),
    /if \(keyDateType && !isFinanceKeyDateType\(keyDateType\)\)/
  );
});

test("the assistant path writes the reminder through the one writer", () => {
  const exec = src("lib/assistant/execute.ts");
  for (const fn of ["add_finance_item", "update_finance_item"]) {
    const body = exec.slice(exec.indexOf(`async ${fn}(`));
    assert.match(
      body.slice(0, 2200),
      /syncFinanceReminder\(userId,/,
      `${fn} must sync the reminder`
    );
  }
  assert.match(exec, /removeFinanceReminder\(userId, itemId\)/);
});

test("a holding says on its own row whether it interrupts him", () => {
  assert.ok(
    remindsOnCalendar(
      holding({ id: "1", key_date: "2026-12-01", key_date_type: "maturity" })
    )
  );
  assert.ok(
    !remindsOnCalendar(
      holding({ id: "2", key_date: "2026-12-01", key_date_type: "review" })
    )
  );
  assert.ok(
    !remindsOnCalendar(
      holding({
        id: "3",
        key_date: "2026-12-01",
        key_date_type: "maturity",
        remind: false,
      })
    )
  );
});

test("an open-ended holding defaults to a review date, a deposit to a maturity", () => {
  // A stock or an open-ended fund has no maturity, so a review date is the
  // only thing that stops it drifting for years.
  assert.equal(defaultKeyDateType("fd"), "maturity");
  assert.equal(defaultKeyDateType("ncd"), "maturity");
  assert.equal(defaultKeyDateType("stock"), "review");
  assert.equal(defaultKeyDateType("mf"), "review");
  assert.equal(defaultKeyDateType("other"), "review");
});

// --- 2. selection at the IST day boundary ----------------------------------

const book: Holding[] = [
  holding({
    id: "fd1",
    kind: "fd",
    name: "HDFC FD, 3 years",
    institution: "HDFC, Navrangpura",
    value: 1500000,
    key_date: "2026-09-01",
    key_date_type: "maturity",
  }),
  holding({
    id: "fd2",
    kind: "fd",
    name: "SBI FD",
    value: 500000,
    key_date: "2026-11-20",
    key_date_type: "maturity",
  }),
  holding({
    id: "mf1",
    kind: "mf",
    name: "Parag Parikh Flexi Cap",
    value: 12000000,
    key_date: "2026-09-01",
    key_date_type: "review",
  }),
  holding({
    id: "st1",
    kind: "stock",
    name: "Direct equity",
    value: 750000,
    key_date: "2026-10-15",
    key_date_type: "review",
  }),
  holding({ id: "nc1", kind: "ncd", name: "An NCD with no date" }),
];

test("a date maturing today is still the next one, right through the IST day", () => {
  assert.equal(nextMaturity(book, "2026-09-01")!.id, "fd1");
  assert.equal(nextReview(book, "2026-09-01")!.id, "mf1");
});

test("the day rolls over on IST midnight, not on UTC midnight", () => {
  // 1 September 2026, 18:35 UTC is 2 September, 00:05 IST. The 1 September
  // maturity is behind him at that instant; the UTC date still says the 1st.
  const justAfterIstMidnight = Date.parse("2026-09-01T18:35:00Z");
  const today = civilToday(justAfterIstMidnight);
  assert.deepEqual(today, { y: 2026, m: 9, d: 2 });
  const key = civilDateKey(today);
  assert.equal(nextMaturity(book, key)!.id, "fd2");
  assert.equal(nextReview(book, key)!.id, "st1");

  // Twenty minutes earlier is still 1 September in IST, so both still lead.
  const justBefore = civilDateKey(civilToday(Date.parse("2026-09-01T18:15:00Z")));
  assert.equal(justBefore, "2026-09-01");
  assert.equal(nextMaturity(book, justBefore)!.id, "fd1");
  assert.equal(nextReview(book, justBefore)!.id, "mf1");
});

test("nothing dated means nothing claimed", () => {
  const undatedOnly = [holding({ id: "x", kind: "stock", name: "Nothing dated" })];
  assert.equal(nextMaturity(undatedOnly, "2026-09-01"), null);
  assert.equal(nextReview(undatedOnly, "2026-09-01"), null);
  assert.equal(reviewLine([]), null);
});

test("a review date that has passed is named, and it leads", () => {
  const today = "2026-09-15";
  const due = reviewsDue(book, today, reviewHorizonKey({ y: 2026, m: 9, d: 15 }));
  // The 1 September review is overdue and inside the window; the 15 October
  // one is beyond the fourteen days and stays quiet.
  assert.deepEqual(
    due.map((d) => d.id),
    ["mf1"]
  );
  assert.equal(due[0].overdue, true);
  assert.match(reviewLine(due)!, /past its review date/);

  // Coming up, not yet passed, reads differently. Same book without the one
  // he has already walked past.
  const ahead = book.filter((h) => h.id !== "mf1");
  const soon = reviewsDue(ahead, "2026-10-05", reviewHorizonKey({ y: 2026, m: 10, d: 5 }));
  assert.deepEqual(
    soon.map((d) => d.id),
    ["st1"]
  );
  assert.equal(soon[0].overdue, false);
  assert.match(reviewLine(soon)!, /due for review/);

  // Overdue and upcoming together: the count of overdue ones leads the line,
  // because that is the number worth reading first.
  const both = reviewsDue(book, "2026-10-05", reviewHorizonKey({ y: 2026, m: 10, d: 5 }));
  assert.deepEqual(
    both.map((d) => d.id),
    ["mf1", "st1"]
  );
  assert.match(reviewLine(both)!, /^1 of 2 holdings are past their review date/);
});

test("the review line reaches Home and the brief, since nothing else carries it", () => {
  // A review date writes no calendar event by design, so these two surfaces
  // are the whole of its reach. If either stops rendering it, the date
  // quietly passes, which is the failure this milestone exists to stop.
  const home = src("app/(app)/page.tsx");
  assert.match(home, /reviewsDue\(/);
  assert.match(home, /moneyLine/);
  const compose = src("lib/brief/compose.ts");
  assert.match(compose, /moneyReviewLine/);
  assert.match(compose, /\$\{moneyBlock\}/);
  const cron = src("app/api/cron/brief/route.ts");
  assert.match(cron, /\.eq\("key_date_type", "review"\)/);
});

// --- 3. Indian digit grouping ----------------------------------------------

test("money reads as Indian, on real figures including a crore", () => {
  assert.equal(formatINR(12000000), "₹ 1,20,00,000");
  assert.equal(formatINR(10000000), "₹ 1,00,00,000");
  assert.equal(formatINR(1500000), "₹ 15,00,000");
  assert.equal(formatINR(350000), "₹ 3,50,000");
  assert.equal(formatINR(3500), "₹ 3,500");
  assert.equal(formatINR(1234.5), "₹ 1,234.50");
  assert.equal(formatINR(null), "");
});

test("the totals by kind are grouped the same way, and stay honest", () => {
  const totals = totalsByKind(book);
  assert.deepEqual(
    totals.map((t) => t.kind),
    ["fd", "mf", "stock", "ncd"]
  );
  const fd = totals.find((t) => t.kind === "fd")!;
  assert.equal(fd.count, 2);
  assert.equal(fd.total_label, "₹ 20,00,000");
  assert.equal(totals.find((t) => t.kind === "mf")!.total_label, "₹ 1,20,00,000");
  // The NCD carries no value. It is counted, and it adds nothing: a total
  // that silently priced it at zero would be a lie he could not see.
  const ncd = totals.find((t) => t.kind === "ncd")!;
  assert.equal(ncd.count, 1);
  assert.equal(ncd.total, 0);
  assert.equal(totalValue(book), 14750000);
  assert.equal(formatINR(totalValue(book)), "₹ 1,47,50,000");
  // Every kind is named in plain words, never by its database value.
  for (const label of Object.values(KIND_LABELS)) {
    assert.ok(!label.includes("_"), `${label} is a database value, not a label`);
  }
});

// --- 4. the sub-monthly series (B2) ----------------------------------------

const from = { y: 2026, m: 9, d: 1 };

test("every N days and every N weeks produce the right next three dates", () => {
  const fortnightly: ObligationSeries = {
    frequency: "custom",
    interval_rule: "weekly:2",
    anchor_date: "2026-09-04",
  };
  assert.deepEqual(nextObligationDates(fortnightly, from, 3), [
    "2026-09-04",
    "2026-09-18",
    "2026-10-02",
  ]);

  const tenDaily: ObligationSeries = {
    frequency: "custom",
    interval_rule: "daily:10",
    anchor_date: "2026-09-05",
  };
  assert.deepEqual(nextObligationDates(tenDaily, from, 3), [
    "2026-09-05",
    "2026-09-15",
    "2026-09-25",
  ]);
});

test("a series that started in the past picks up from today, on the beat", () => {
  // Anchored on 1 January, asked about 1 September: the next date must land
  // on the series, not on today.
  const weekly: ObligationSeries = {
    frequency: "custom",
    interval_rule: "weekly:1",
    anchor_date: "2026-01-02",
  };
  const dates = nextObligationDates(weekly, from, 3);
  assert.deepEqual(dates, ["2026-09-04", "2026-09-11", "2026-09-18"]);
  // Every date is a whole number of weeks from the anchor.
  for (const d of dates) {
    const days =
      (Date.UTC(...([2026, 0, 2] as [number, number, number])) -
        Date.UTC(parseDateKey(d).y, parseDateKey(d).m - 1, parseDateKey(d).d)) /
      86400000;
    assert.equal(Math.abs(days % 7), 0, `${d} is off the weekly beat`);
  }
});

test("a date falling exactly today is the next one, not the one after", () => {
  const daily: ObligationSeries = {
    frequency: "custom",
    interval_rule: "daily:5",
    anchor_date: "2026-09-01",
  };
  assert.equal(nextObligationDates(daily, from, 1)[0], "2026-09-01");
});

test("the monthly family honours its own interval in the dates he is shown", () => {
  // Quarterly means three months apart, not "the next three months".
  assert.deepEqual(
    nextObligationDates({ frequency: "quarterly", due_day: 15 }, from, 3),
    ["2026-09-15", "2026-12-15", "2027-03-15"]
  );
  assert.deepEqual(
    nextObligationDates({ frequency: "monthly", due_day: 5 }, from, 3),
    ["2026-09-05", "2026-10-05", "2026-11-05"]
  );
  assert.deepEqual(
    nextObligationDates({ frequency: "yearly", due_day: 15, due_month: 4 }, from, 2),
    ["2027-04-15", "2028-04-15"]
  );
});

test("a 31st falls back to the last day of a shorter month", () => {
  assert.deepEqual(
    nextObligationDates({ frequency: "monthly", due_day: 31 }, { y: 2026, m: 1, d: 1 }, 4),
    ["2026-01-31", "2026-02-28", "2026-03-31", "2026-04-30"]
  );
});

test("the rule Google expands is the rule he is shown", () => {
  assert.equal(
    obligationSeriesRRule({
      frequency: "custom",
      interval_rule: "weekly:2",
      anchor_date: "2026-09-04",
    }),
    "RRULE:FREQ=WEEKLY;INTERVAL=2"
  );
  assert.equal(
    obligationSeriesRRule({
      frequency: "custom",
      interval_rule: "daily:10",
      anchor_date: "2026-09-05",
    }),
    "RRULE:FREQ=DAILY;INTERVAL=10"
  );
  assert.equal(
    obligationSeriesRRule({ frequency: "custom", interval_rule: "daily:1", anchor_date: "2026-09-05" }),
    "RRULE:FREQ=DAILY"
  );
  // The monthly family is untouched: same string M3 has always written.
  assert.equal(
    obligationSeriesRRule({ frequency: "quarterly", due_day: 15 }),
    "RRULE:FREQ=MONTHLY;INTERVAL=3;BYMONTHDAY=15"
  );
});

test("the writer anchors the calendar event on the first date of that series", () => {
  // What he reads on the card and what Google expands come from one
  // function, so they cannot drift apart.
  const writer = src("lib/reminders/writer.ts");
  assert.match(writer, /obligationSeriesRRule\(series\)/);
  assert.match(writer, /nextObligationDates\(series, today, 1\)\[0\]/);
  const panel = src("components/money/obligations-panel.tsx");
  assert.match(panel, /nextObligationDates\(o, parseDateKey\(todayKey\), 3\)/);
});

test("an unreadable series is refused, never quietly written", () => {
  assert.equal(customStepDays("weekly:2"), 14);
  assert.equal(customStepDays("daily:10"), 10);
  assert.equal(customStepDays("weekly"), 7);
  assert.throws(() => customStepDays(null), /rule like/);
  assert.throws(() => customStepDays("fortnightly"), /rule like/);
  // Monthly and longer belong in the enum, not in a custom rule.
  assert.throws(() => customStepDays("monthly:2"), /days or weeks/);
  assert.throws(() => parseDateKey(null), /start date/);
  assert.throws(() => parseDateKey("4 September 2026"), /start date/);
  // And the server action is where a bad pair is caught before it is saved.
  assert.match(src("app/(app)/money/actions.ts"), /customStepDays\(input\.interval_rule\)/);
});

// --- 5. the rate reaches the assistant --------------------------------------

const streams = [
  { name: "ICAI", hourly_rate: 3500, active: true },
  { name: "Tax Strategia", hourly_rate: 12000, active: true },
  { name: "Personal", hourly_rate: null, active: true },
  { name: "An old stream", hourly_rate: 9999, active: false },
];

test("each stream's own rate reaches the model's context, grouped as Indian", () => {
  const line = streamRateLine(streams);
  assert.match(line, /ICAI \(₹ 3,500 an hour\)/);
  assert.match(line, /Tax Strategia \(₹ 12,000 an hour\)/);
  // A stream with no rate says so, rather than being given the floor
  // silently: an assumed number is one he would never see and never correct.
  assert.match(line, /Personal \(no rate recorded\)/);
  assert.match(line, /₹ 3,500 an hour floor/);
  // Retired streams stay out of it.
  assert.ok(!line.includes("An old stream"));
  assert.equal(RATE_FLOOR, 3500);
});

test("the context builder actually reads the rate", () => {
  const context = src("lib/assistant/context.ts");
  assert.match(context, /select\(\s*"name, kind, active, hourly_rate"\s*\)/);
  assert.match(context, /streamRateLine\(/);
  // The old bare list of names must be gone, or the rate never arrives.
  assert.ok(
    !context.includes('"Work streams: " +'),
    "the plain work-streams line was left in place"
  );
});

test("the hard rule points at the stream's rate, not at one remembered number", () => {
  assert.match(HARD_RULES, /use the stream's OWN rate and say the number/i);
  assert.match(HARD_RULES, /Rs 3,500 an hour/);
});

test("no tool quotes, invoices or tracks time on the back of the rate", () => {
  // B4 stores one number and tells the assistant. Nothing else.
  for (const t of TOOLS) {
    assert.doesNotMatch(
      t.name,
      /(quote|invoice|timesheet|time_entry|bill)/i,
      `${t.name} goes beyond what B4 asked for`
    );
    const props = Object.keys(
      (t.input_schema as { properties?: Record<string, unknown> }).properties ?? {}
    );
    for (const p of props) {
      assert.doesNotMatch(
        p,
        /^(hourly_rate|rate_per_hour|hours|quote)/i,
        `${t.name}.${p} would let a model set his price`
      );
    }
  }
});

// --- 6. the confidential boundary, where money invites it -------------------

// Anything that identifies an account rather than describing a holding.
const FORBIDDEN_FIELD =
  /(account_no|account_num|acct_no|folio|customer_id|client_id|ifsc|iban|demat|cif|card_no|card_num|cvv|pin|password|username|login|statement|passbook)/i;
const FILE_SHAPED = /^(file|upload|attachment|document|content|base64|scan_of|photo|image)/i;

test("no tool parameter accepts an account number, a folio number or a file", () => {
  for (const t of TOOLS) {
    const props = Object.keys(
      (t.input_schema as { properties?: Record<string, unknown> }).properties ?? {}
    );
    for (const p of props) {
      assert.doesNotMatch(p, FORBIDDEN_FIELD, `${t.name}.${p} identifies an account`);
      assert.doesNotMatch(p, FILE_SHAPED, `${t.name}.${p} looks like a document field`);
    }
  }
});

test("no investment column holds one either", () => {
  // The schema is the real boundary: a column that existed could be filled
  // from anywhere. finance_items shipped in M1 with these columns and M7b
  // adds none.
  const initial = src("supabase/migrations/20260706000100_initial_schema.sql");
  const block = initial.slice(
    initial.indexOf("create table finance_items"),
    initial.indexOf("create table recurring_obligations")
  );
  assert.ok(block.length > 0, "finance_items must still be in the initial schema");
  for (const line of block.split("\n")) {
    assert.doesNotMatch(line, FORBIDDEN_FIELD, `finance_items column: ${line.trim()}`);
  }
  // And this milestone's own migration adds no column to it.
  const m7b = src("supabase/migrations/20260901000600_m7b_money.sql");
  assert.ok(
    !/alter table finance_items\s+add column/i.test(m7b),
    "M7b must add no column to finance_items"
  );
  assert.match(m7b, /NEVER an account number, a folio number/);
});

test("the holding form and the tool both say the field is a label, not an identifier", () => {
  const schema = JSON.stringify(toolByName("add_finance_item")!.input_schema);
  assert.match(schema, /Never an account number, a folio number, a customer id or a login/);
  assert.match(
    JSON.stringify(toolByName("update_finance_item")!.input_schema),
    /Never an account number/
  );
  assert.match(
    src("components/money/investments-panel.tsx"),
    /Never an account number, a folio number or a\s*\n?\s*login/
  );
});

test("the money module opens no upload path", () => {
  for (const rel of [
    "components/money/investments-panel.tsx",
    "app/(app)/money/actions.ts",
    "app/(app)/money/page.tsx",
    "lib/money/investments.ts",
  ]) {
    const file = src(rel);
    assert.ok(!/type="file"/.test(file), `${rel} offers a file input`);
    assert.ok(!/FormData|createSignedUploadUrl|storage\.from/.test(file), `${rel} touches storage`);
  }
});

// --- the tool-schema house rules (do not regress) ---------------------------

test("every parameter still carries one concrete type", () => {
  for (const t of TOOLS) {
    const walk = (n: unknown, path: string): void => {
      if (!n || typeof n !== "object") return;
      if (Array.isArray(n)) return n.forEach((x, i) => walk(x, `${path}[${i}]`));
      const o = n as Record<string, unknown>;
      assert.ok(!Array.isArray(o.type), `${t.name} ${path} has a union type`);
      assert.ok(!o.anyOf && !o.oneOf, `${t.name} ${path} uses anyOf/oneOf`);
      for (const [k, v] of Object.entries(o)) walk(v, `${path}.${k}`);
    };
    walk(t.input_schema, t.name);
  }
});

test("the new investment parameters are optional and single-typed", () => {
  for (const name of ["add_finance_item", "update_finance_item"]) {
    const s = toolByName(name)!.input_schema as unknown as {
      properties: Record<string, { type?: unknown; enum?: unknown }>;
      required: string[];
    };
    const kdt = s.properties.key_date_type;
    assert.equal(kdt.type, "string");
    assert.deepEqual(kdt.enum, ["maturity", "review"]);
    assert.ok(!s.required.includes("key_date_type"), `${name} must not require it`);
    assert.ok(!s.required.includes("institution"), `${name} must not require it`);
  }
});
