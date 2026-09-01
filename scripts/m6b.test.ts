// Offline proof for Milestone 6b (trip checklists). Run: npm run test:m6b
// (Node 22.18+, the same native TS type-stripping as the m3/m4/m5/m6 suites.)
// No network, no database: everything proven here is pure logic.
//
// What is proven:
//   1. The rollup counts honestly, names the next step, and drops a trip
//      whose steps are all done.
//   2. The rollup inherits the rank of its most urgent incomplete step, so
//      an overdue step forces the trip into the same band that step earned,
//      and a completed step stops counting towards the rank.
//   3. Checklist dates derive from the trip's own dates, including a trip
//      starting inside seven days, and never land in the past.
//   4. The rollup and the brief cannot drift: the brief ranks the same rows.
//   5. The tool surface carries trip_id and with_checklist as single-typed
//      optional parameters, the house rule the m4 suite also enforces.

import test from "node:test";
import assert from "node:assert/strict";
import {
  rollUpTrips,
  splitTripTasks,
  type TripStep,
} from "../lib/tasks/trip-rollup.ts";
import { triage } from "../lib/tasks/triage.ts";
import { buildChecklist } from "../lib/trips/checklist.ts";
import { composeBrief, type BriefTask } from "../lib/brief/compose.ts";
import { TOOLS, toolByName } from "../lib/assistant/tools.ts";

// Fixed clock: 25 August 2026, 11:30 IST (06:00 UTC).
const NOW = Date.parse("2026-08-25T06:00:00Z");
const RAJKOT = {
  id: "trip-1",
  title: "AICA session, Rajkot branch",
  start_date: "2026-09-03",
  end_date: "2026-09-04",
};

function step(over: Partial<TripStep> & { id: string }): TripStep {
  return {
    title: "Book onward ticket",
    priority: "medium",
    due_ts: "2026-08-27T04:00:00Z",
    status: "todo",
    trip: RAJKOT,
    ...over,
  };
}

// --- 1. counts, naming, and the finished trip --------------------------------

const PART_DONE: TripStep[] = [
  step({ id: "s1", title: "Book onward ticket", due_ts: "2026-08-20T04:00:00Z" }),
  step({ id: "s2", title: "Book return ticket", due_ts: "2026-08-27T04:00:00Z", status: "done" }),
  step({ id: "s3", title: "Confirm hotel with the branch", due_ts: "2026-08-29T04:00:00Z", status: "done" }),
  step({ id: "s4", title: "Collect and keep travel receipts", due_ts: "2026-09-04T04:00:00Z" }),
  step({ id: "s5", title: "Build the reimbursement bill", due_ts: "2026-09-06T04:00:00Z" }),
];

test("five steps become one honest line", () => {
  const [row] = rollUpTrips(PART_DONE, NOW);
  assert.equal(rollUpTrips(PART_DONE, NOW).length, 1);
  assert.equal(row.done, 2);
  assert.equal(row.total, 5);
  assert.equal(row.progress, "2 of 5 done");
  assert.equal(row.trip_id, "trip-1");
  assert.equal(row.label, "AICA session, Rajkot branch, 3 to 4 September 2026");
});

test("the line names the step the trip is waiting on", () => {
  const [row] = rollUpTrips(PART_DONE, NOW);
  assert.equal(row.next_title, "Book onward ticket");
});

test("a trip with every step done produces no row at all", () => {
  const finished = PART_DONE.map((s) => ({ ...s, status: "done" }));
  assert.deepEqual(rollUpTrips(finished, NOW), []);
});

test("a dropped step leaves the denominator", () => {
  const withDropped = [
    ...PART_DONE.slice(0, 4),
    step({ id: "s5", title: "Build the reimbursement bill", status: "dropped" }),
  ];
  const [row] = rollUpTrips(withDropped, NOW);
  assert.equal(row.total, 4);
  assert.equal(row.progress, "2 of 4 done");
});

test("two trips make two lines, never one merged list", () => {
  const surat = { id: "trip-2", title: "AICA session, Surat branch", start_date: "2026-09-07", end_date: "2026-09-08" };
  const rows = rollUpTrips(
    [...PART_DONE, step({ id: "s6", trip: surat, due_ts: "2026-08-31T04:00:00Z" })],
    NOW
  );
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((r) => r.trip_id).sort(), ["trip-1", "trip-2"]);
});

test("a rollup id can never be mistaken for a task id", () => {
  const [row] = rollUpTrips(PART_DONE, NOW);
  assert.equal(row.id, "trip:trip-1");
  assert.ok(!PART_DONE.some((s) => s.id === row.id));
});

// --- 2. inherited urgency ----------------------------------------------------

test("an overdue step drags the whole trip into the band it earned", () => {
  const [row] = rollUpTrips(PART_DONE, NOW);
  // s1 is due 20 August, five days before "now": overdue, medium priority.
  assert.equal(row.due_ts, "2026-08-20T04:00:00Z");
  assert.equal(row.priority, "medium");

  const bands = triage([row], NOW);
  assert.equal(bands.urgent.length, 1, "overdue and not high priority: urgent band");
  assert.equal(bands.do_first.length, 0);
  assert.equal(bands.later.length, 0);
});

test("a high-priority overdue step puts the trip in Do first", () => {
  const steps = [
    step({ id: "s1", priority: "high", due_ts: "2026-08-20T04:00:00Z" }),
    step({ id: "s2", due_ts: "2026-09-06T04:00:00Z" }),
  ];
  const [row] = rollUpTrips(steps, NOW);
  assert.equal(triage([row], NOW).do_first.length, 1);
});

test("the trip ranks exactly where its leading step would have ranked alone", () => {
  const [row] = rollUpTrips(PART_DONE, NOW);
  const open = PART_DONE.filter((s) => s.status === "todo");
  const loose = triage(open, NOW);
  const leadBand = loose.urgent[0] ?? loose.do_first[0] ?? loose.important[0] ?? loose.later[0];
  assert.equal(row.due_ts, leadBand.due_ts);
  assert.equal(row.priority, leadBand.priority);
  assert.equal(row.next_title, leadBand.title);
});

test("completing the overdue step calms the trip down", () => {
  const fixed = PART_DONE.map((s) => (s.id === "s1" ? { ...s, status: "done" } : s));
  const [row] = rollUpTrips(fixed, NOW);
  assert.equal(row.done, 3);
  assert.equal(row.next_title, "Collect and keep travel receipts");
  // 4 September is more than 48 hours out from 25 August, so no longer urgent.
  assert.equal(triage([row], NOW).urgent.length, 0);
  assert.equal(triage([row], NOW).later.length, 1);
});

test("splitTripTasks takes the steps out of the flat list and puts trips back", () => {
  const flat = [
    { id: "a", title: "File reply to SCN", priority: "high" as const, due_ts: null, status: "todo", trip_id: null },
    { id: "s1", title: "Book onward ticket", priority: "medium" as const, due_ts: null, status: "todo", trip_id: "trip-1" },
  ];
  const { standalone, rollups } = splitTripTasks(flat, PART_DONE, NOW);
  assert.deepEqual(standalone.map((t) => t.id), ["a"]);
  assert.equal(rollups.length, 1);
});

// --- 3. checklist dates ------------------------------------------------------

const TRIP = {
  title: "AICA session, Rajkot branch",
  purpose: "aica",
  start_date: "2026-09-03",
  end_date: "2026-09-04",
  billable_to: "ICAI Rajkot Branch",
};

test("the standard checklist is five steps, dated from the trip", () => {
  const steps = buildChecklist(TRIP, "2026-08-01");
  assert.deepEqual(
    steps.map((s) => [s.key, s.due_date]),
    [
      ["onward", "2026-08-27"], // 7 days before the start
      ["return", "2026-08-27"], // 7 days before the start
      ["hotel", "2026-08-29"], // 5 days before the start
      ["receipts", "2026-09-04"], // the end date
      ["bill", "2026-09-06"], // 2 days after the end date
    ]
  );
});

test("a trip starting inside seven days still produces a usable list", () => {
  // Entered on 1 September for a trip starting on the 3rd: the two booking
  // steps would fall on 27 August, which has gone.
  const steps = buildChecklist(TRIP, "2026-09-01");
  assert.equal(steps.length, 5);
  assert.equal(steps[0].due_date, "2026-09-01");
  assert.equal(steps[1].due_date, "2026-09-01");
  assert.equal(steps[2].due_date, "2026-09-01");
  // Dates still ahead are untouched.
  assert.equal(steps[3].due_date, "2026-09-04");
  assert.equal(steps[4].due_date, "2026-09-06");
});

test("no step is ever dated in the past", () => {
  const steps = buildChecklist(TRIP, "2026-12-25");
  assert.ok(steps.every((s) => s.due_date >= "2026-12-25"));
});

test("a trip with no start date offers no checklist rather than guessing", () => {
  assert.deepEqual(buildChecklist({ ...TRIP, start_date: null }, "2026-08-01"), []);
});

test("a one-day trip counts the end date from the start date", () => {
  const steps = buildChecklist({ ...TRIP, end_date: null }, "2026-08-01");
  assert.equal(steps[3].due_date, "2026-09-03");
  assert.equal(steps[4].due_date, "2026-09-05");
});

test("AICA copy names the preference order and the branch's hotel", () => {
  const steps = buildChecklist(TRIP, "2026-08-01");
  assert.match(steps[0].note, /Vande Bharat, then Tejas, then AC sleeper, then cab/);
  assert.match(steps[0].note, /night before/);
  assert.equal(steps[2].title, "Confirm hotel with the branch");
  assert.match(steps[2].note, /confirmation, not a booking/);
});

test("a non-AICA trip loses the bill step without a payer", () => {
  // Since milestone 6c the hotel wording follows the trip's hotel_arrangement,
  // not its purpose: a branch arranges his hotel on almost every trip, so a
  // trip that has not said otherwise reads as 'branch'. What the purpose still
  // decides is the bill: only AICA is billable without an explicit payer.
  const leisure = {
    title: "Family trip",
    purpose: "leisure",
    start_date: "2026-09-03",
    end_date: "2026-09-04",
    billable_to: null,
  };
  const steps = buildChecklist(leisure, "2026-08-01");
  assert.deepEqual(steps.map((s) => s.key), ["onward", "return", "hotel", "receipts"]);

  // Named a payer, so the reimbursement step comes back.
  const billed = buildChecklist({ ...leisure, billable_to: "Cygnet" }, "2026-08-01");
  assert.deepEqual(billed.map((s) => s.key).at(-1), "bill");
});

test("no checklist step invites a document into the app", () => {
  const steps = buildChecklist(TRIP, "2026-08-01");
  const receipts = steps.find((s) => s.key === "receipts")!;
  assert.match(receipts.note, /the app records a reference only/);
  assert.ok(!/upload|attach the file/i.test(JSON.stringify(steps)));
});

// --- 4. the brief cannot drift from the screens ------------------------------

function briefTask(over: Partial<BriefTask> & { id: string }): BriefTask {
  return {
    title: "File reply to SCN issued to R N PEB",
    priority: "high",
    due_ts: "2026-08-25T04:00:00Z",
    status: "todo",
    stream: "Tax Strategia",
    source: "manual",
    created_at: "2026-08-01T00:00:00Z",
    trip_id: null,
    ...over,
  };
}

test("the brief shows one line per trip, not a line per step", () => {
  const { text } = composeBrief({
    nowMs: NOW,
    tasks: [
      briefTask({ id: "a" }),
      // The steps arrive in the open-task list too; the composer must drop
      // them in favour of the rollup.
      briefTask({ id: "s1", title: "Book onward ticket", trip_id: "trip-1" }),
      briefTask({ id: "s4", title: "Collect and keep travel receipts", trip_id: "trip-1" }),
    ],
    tripSteps: PART_DONE,
    events: [],
    pendingApprovalsCount: 0,
    accountsNeedingReconnect: [],
    appBaseUrl: "https://example.test",
  });
  assert.ok(text.includes("AICA session, Rajkot branch, 3 to 4 September 2026"));
  assert.ok(text.includes("2 of 5 done, next: Book onward ticket"));
  // The steps themselves are not lines of their own.
  assert.ok(!text.includes("- Book onward ticket"));
  assert.ok(!text.includes("- Collect and keep travel receipts"));
});

test("the brief ranks the trip in the same band the screens do", () => {
  const { html } = composeBrief({
    nowMs: NOW,
    tasks: [],
    tripSteps: PART_DONE,
    events: [],
    pendingApprovalsCount: 0,
    accountsNeedingReconnect: [],
    appBaseUrl: "https://example.test",
  });
  // Overdue leading step, medium priority: the "Urgent, less important" band,
  // exactly where triage puts the rollup row above.
  assert.ok(html.includes("Urgent, less important"));
  assert.ok(html.includes("AICA session, Rajkot branch"));
  assert.ok(html.includes("overdue"));
});

test("a brief with no trips is unchanged", () => {
  const plain = composeBrief({
    nowMs: NOW,
    tasks: [briefTask({ id: "a" })],
    events: [],
    pendingApprovalsCount: 0,
    accountsNeedingReconnect: [],
    appBaseUrl: "https://example.test",
  });
  assert.ok(plain.text.includes("File reply to SCN issued to R N PEB"));
  assert.ok(!plain.text.includes("of 5 done"));
});

// --- 5. the tool surface -----------------------------------------------------

test("tasks can be attached to a trip through the assistant and both connectors", () => {
  for (const name of ["create_task", "update_task"]) {
    const props = toolByName(name)!.input_schema.properties as Record<string, { type: string }>;
    assert.equal(props.trip_id.type, "string", `${name} takes a trip_id`);
    const required = (toolByName(name)!.input_schema.required ?? []) as string[];
    assert.ok(!required.includes("trip_id"), `${name}'s trip_id is optional`);
  }
});

test("create_trip can seed the checklist, and it is off unless asked", () => {
  const tool = toolByName("create_trip")!;
  const props = tool.input_schema.properties as Record<string, { type: string }>;
  assert.equal(props.with_checklist.type, "boolean");
  assert.ok(!((tool.input_schema.required ?? []) as string[]).includes("with_checklist"));
});

test("the new parameters keep the one-concrete-type rule", () => {
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

test("nothing new can approve, send or mark a bill", () => {
  const kinds = TOOLS.map((t) => t.name);
  assert.ok(!kinds.some((k) => /approve|mark_bill|send_bill/i.test(k)));
  assert.equal(toolByName("create_trip")!.bucket, "autonomous");
});
