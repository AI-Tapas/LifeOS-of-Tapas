// B19 offline proof: no repeated tasks, and nothing shown before it can
// start. Run: npm run test:b19
//
// Tapas, 26 September 2026: "Unless and until the September month is over,
// there is no point in starting the October invoice, let alone the November
// invoice." And the other fault he named: repeated tasks.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  isUrgent,
  isWaiting,
  startDateProblem,
  triage,
  waitingLine,
  weekendGuard,
  type TriageTask,
} from "../lib/tasks/triage.ts";
import { nextOccurrence, periodStartKey } from "../lib/tasks/recurring.ts";
import {
  duplicateScore,
  findNearDuplicate,
  namedFuturePeriod,
  NEAR_DUPLICATE_THRESHOLD,
} from "../lib/tasks/near-duplicate.ts";
import { rollUpTrips, type TripStep } from "../lib/tasks/trip-rollup.ts";
import { composeBrief, type BriefTask } from "../lib/brief/compose.ts";
import { isAlreadyOpen } from "../lib/assistant/scan-filters.ts";
import { toolByName } from "../lib/assistant/tools.ts";
import { buildReport, type ReportRow } from "./report-premature-tasks.ts";

const src = (rel: string) => readFileSync(new URL("../" + rel, import.meta.url), "utf8");

// 27 September 2026, 11:30 am IST, a Sunday.
const NOW = Date.parse("2026-09-27T06:00:00Z");
const DAY = 86400000;

function t(
  id: string,
  over: Partial<TriageTask> = {}
): TriageTask {
  return { id, title: id, priority: "medium", due_ts: null, status: "todo", ...over };
}

// --- 1. triage: waiting tasks are counted, never ranked --------------------

test("triage leaves out a task whose start date is tomorrow and counts it; includes it on the day", () => {
  const tomorrow = t("oct-invoice", { not_before: "2026-09-28", priority: "high" });
  const today = t("today", { not_before: "2026-09-27" });
  const none = t("plain");
  const r = triage([tomorrow, today, none], NOW);
  const banded = [...r.do_first, ...r.important, ...r.urgent, ...r.later].map((x) => x.id);
  assert.deepEqual(r.waiting.map((x) => x.id), ["oct-invoice"]);
  assert.ok(!banded.includes("oct-invoice"), "a waiting task sits in no band");
  assert.ok(banded.includes("today"), "a start date of today is not waiting");
  assert.ok(banded.includes("plain"));

  // The same task, on its start date (28 September, 9 am IST): ranked.
  const onTheDay = triage([tomorrow], Date.parse("2026-09-28T03:30:00Z"));
  assert.equal(onTheDay.waiting.length, 0);
  assert.deepEqual(onTheDay.important.map((x) => x.id), ["oct-invoice"]);

  // Just before midnight IST on the 27th it is still waiting: the day is IST.
  assert.equal(isWaiting(tomorrow, Date.parse("2026-09-27T18:29:00Z")), true);
  assert.equal(isWaiting(tomorrow, Date.parse("2026-09-27T18:31:00Z")), false);
});

test("a task due in 24 hours but not startable until next week is not urgent", () => {
  const task = t("x", {
    priority: "high",
    due_ts: new Date(NOW + DAY).toISOString(),
    not_before: "2026-10-04",
  });
  assert.equal(isUrgent(task, NOW), false);
  const r = triage([task], NOW);
  assert.equal(r.do_first.length + r.urgent.length, 0);
  assert.equal(r.waiting.length, 1);
  // Without the start date the same task is the top of the list.
  assert.equal(isUrgent({ ...task, not_before: null }, NOW), true);
});

test("the waiting count line is one sentence, and silent at zero", () => {
  assert.equal(waitingLine(0), null);
  assert.equal(waitingLine(1), "1 task is waiting for its start date.");
  assert.equal(waitingLine(3), "3 tasks are waiting for their start date.");
});

test("the weekend guard does not tell him to start work that cannot start yet", () => {
  // Wednesday 30 September; Saturday 3 to Monday 5 October.
  const wed = Date.parse("2026-09-30T06:00:00Z");
  const keys: [string, string, string] = ["2026-10-03", "2026-10-04", "2026-10-05"];
  const due = "2026-10-05T04:00:00Z";
  const waiting = t("w", { due_ts: due, not_before: "2026-10-01" });
  const ready = t("r", { due_ts: due });
  assert.deepEqual(weekendGuard([waiting, ready], 3, keys, wed).map((x) => x.id), ["r"]);
  // Callers that pass no clock keep the old behaviour.
  assert.equal(weekendGuard([waiting, ready], 3, keys).length, 2);
});

test("a trip line waits only when every open step waits", () => {
  const trip = { id: "trip-1", title: "AICA session", start_date: "2026-10-20", end_date: "2026-10-21" };
  const step = (id: string, over: Partial<TripStep> = {}): TripStep => ({
    ...t(id),
    due_ts: "2026-10-13T04:00:00Z",
    trip,
    ...over,
  });
  const allWaiting = rollUpTrips([step("a", { not_before: "2026-10-10" })], NOW);
  assert.equal(allWaiting.length, 1);
  assert.equal(triage(allWaiting, NOW).waiting.length, 1, "the whole trip line waits");

  const mixed = rollUpTrips(
    [step("a", { not_before: "2026-10-10", title: "Later step" }), step("b", { title: "Book onward ticket" })],
    NOW
  );
  assert.equal(mixed[0].next_title, "Book onward ticket", "a startable step leads");
  assert.equal(triage(mixed, NOW).waiting.length, 0);
});

test("the morning brief ranks the same way and says how many wait", () => {
  const task = (id: string, over: Partial<BriefTask> = {}): BriefTask => ({
    ...t(id),
    title: id,
    stream: "ICAI",
    source: "manual",
    created_at: "2026-09-01T00:00:00Z",
    ...over,
  });
  const { text, html } = composeBrief({
    nowMs: NOW,
    tasks: [
      task("Raise the AICA invoice for October", {
        priority: "high",
        due_ts: "2026-09-28T04:00:00Z",
        not_before: "2026-11-01",
      }),
      task("File reply to SCN", { priority: "high", due_ts: "2026-09-28T04:00:00Z" }),
    ],
    events: [],
    pendingApprovalsCount: 0,
    accountsNeedingReconnect: [],
    appBaseUrl: "https://example.test",
  });
  assert.ok(text.includes("File reply to SCN"));
  assert.ok(!text.includes("Raise the AICA invoice for October"), "a waiting task is not listed");
  assert.ok(text.includes("1 task is waiting for its start date."));
  assert.ok(html.includes("1 task is waiting for its start date."));
});

// --- 2. the start date itself -------------------------------------------------

test("a start date must be a real date and never after the due date", () => {
  assert.equal(startDateProblem(null, null), null);
  assert.equal(startDateProblem(undefined, "2026-10-03T04:00:00Z"), null);
  assert.equal(startDateProblem("2026-10-01", "2026-10-03T04:00:00Z"), null);
  // Same IST day as the due date is fine.
  assert.equal(startDateProblem("2026-10-03", "2026-10-03T04:00:00Z"), null);
  assert.match(startDateProblem("2026-11-01", "2026-10-03T04:00:00Z")!, /after the due date/);
  assert.match(startDateProblem("1 Nov 2026", null)!, /YYYY-MM-DD/);
  assert.match(startDateProblem("2026-02-30", null)!, /YYYY-MM-DD/);
});

test("the migration adds a nullable date with a due-date check and backfills nothing", () => {
  const sql = src("supabase/migrations/20260927000100_b19_task_not_before.sql");
  assert.match(sql, /add column if not exists not_before date;/);
  assert.match(sql, /not_before <= \(due_ts at time zone 'Asia\/Kolkata'\)::date/);
  assert.doesNotMatch(sql, /update\s+(public\.)?tasks/i, "which tasks are premature is his call");
  assert.doesNotMatch(sql, /disable row level security/i);
});

// --- 3. recurring spawn -------------------------------------------------------

test("a monthly recurring spawn waits for the start of its own month", () => {
  // Completing the occurrence due 3 October (September's invoice) spawns the
  // one due 3 November, which covers October and can start on 1 November.
  const next = nextOccurrence("monthly", "2026-10-03T04:00:00Z");
  assert.deepEqual(next, { due_ts: "2026-11-03T04:00:00.000Z", not_before: "2026-11-01" });
  // Year rollover.
  assert.deepEqual(nextOccurrence("monthly", "2026-12-03T04:00:00Z"), {
    due_ts: "2027-01-03T04:00:00.000Z",
    not_before: "2027-01-01",
  });
  assert.equal(nextOccurrence(null, "2026-10-03T04:00:00Z"), null);
});

test("the period start follows the rule's frequency", () => {
  const due = "2026-10-08T04:00:00Z"; // Thursday 8 October, IST
  assert.equal(periodStartKey("daily", due), "2026-10-08");
  assert.equal(periodStartKey("weekly", due), "2026-10-05", "the Monday of that week");
  assert.equal(periodStartKey("monthly:3", due), "2026-10-01");
  assert.equal(periodStartKey("yearly", due), "2026-01-01");
  // The start is never after the due date, so the database check always holds.
  for (const rule of ["daily", "weekly:2", "monthly", "yearly"]) {
    assert.equal(startDateProblem(periodStartKey(rule, due), due), null, rule);
  }
});

test("the spawner writes the next occurrence's start date through nextOccurrence", () => {
  const write = src("lib/tasks/write.ts");
  const spawn = write.slice(write.indexOf("async function spawnNextOccurrence"));
  assert.match(spawn, /nextOccurrence\(t\.recurring_rule, t\.due_ts\)/);
  assert.match(spawn, /not_before: next\.not_before/);
  assert.match(spawn, /due_ts: next\.due_ts/);
});

// --- 4. near duplicates -------------------------------------------------------

test("a near-duplicate title is refused, and the next month's is not", () => {
  const sept = "Raise AICA invoice for September";
  assert.ok(duplicateScore(sept, "raise the AICA invoice - September") >= NEAR_DUPLICATE_THRESHOLD);
  assert.ok(duplicateScore(sept, "Raise AICA invoice for October") < NEAR_DUPLICATE_THRESHOLD);
  // Abbreviations are the same month; a different month is different work
  // however many other words the titles share.
  assert.ok(duplicateScore(sept, "Raise AICA invoice, Sept") >= NEAR_DUPLICATE_THRESHOLD);
  assert.equal(
    duplicateScore(
      "Raise the AICA fee and reimbursement invoices to the ICAI AI committee for October 2026",
      "Raise the AICA fee and reimbursement invoices to the ICAI AI committee for November 2026"
    ),
    0
  );
  assert.equal(duplicateScore("File ITR for FY 2026-27", "File ITR for FY 2027-28"), 0);
  // Near is not loose: a different client, or a different leg, stays distinct.
  assert.ok(
    duplicateScore(
      "Review AWS cost budget alert for Nami Realties account",
      "Review AWS cost budget alert for Sunrise Traders account"
    ) < NEAR_DUPLICATE_THRESHOLD
  );
  assert.ok(duplicateScore("Book onward ticket, Rajkot", "Book return ticket, Rajkot") < NEAR_DUPLICATE_THRESHOLD);
});

test("findNearDuplicate names the closest open task so the caller updates it", () => {
  const open = [
    { id: "t-oct", title: "Raise AICA invoice for October" },
    { id: "t-sep", title: "Raise the AICA invoice - September" },
  ];
  assert.equal(findNearDuplicate("Raise AICA invoice for September", open)?.task.id, "t-sep");
  assert.equal(findNearDuplicate("Raise AICA invoice for November", open), null);
});

test("create_task refuses near duplicates through the scorer, and the mail scan does too", () => {
  const exec = src("lib/assistant/execute.ts");
  const create = exec.slice(exec.indexOf("async create_task("), exec.indexOf("async update_task("));
  assert.match(create, /findNearDuplicate\(/);
  assert.match(create, /\.in\("status", \["inbox", "todo", "doing"\]\)/, "waiting tasks are open too");
  assert.doesNotMatch(create, /\.ilike\("title"/, "the old exact-title check is gone");
  assert.match(create, /id \$\{dup\.task\.id\}/, "the refusal names the task to update");
  // The scan's second belt uses the same score.
  assert.equal(
    isAlreadyOpen("raise the AICA invoice - September", ["Raise AICA invoice for September"]),
    true
  );
  assert.equal(
    isAlreadyOpen("Raise AICA invoice for October", ["Raise AICA invoice for September"]),
    false
  );
});

// --- 5. the tools ---------------------------------------------------------------

test("create_task and update_task take an optional single-typed not_before", () => {
  for (const name of ["create_task", "update_task"]) {
    const tool = toolByName(name)!;
    const props = tool.input_schema.properties as Record<string, { type: unknown; description: string }>;
    assert.equal(props.not_before.type, "string", `${name}.not_before is one concrete type`);
    assert.ok(!((tool.input_schema.required ?? []) as string[]).includes("not_before"));
    assert.match(props.not_before.description, /YYYY-MM-DD/);
    assert.match(props.not_before.description, /a month's invoice starts after that month ends/);
    assert.match(props.not_before.description, /next month's work is never urgent this month/);
  }
});

test("lifeos_list_tasks leaves waiting tasks out by default and has include_waiting", () => {
  const api = src("lib/assistant/mcp-api.ts");
  const schema = api.slice(api.indexOf("lifeos_list_tasks: {"), api.indexOf("lifeos_list_events: {"));
  assert.match(schema, /include_waiting: \{\s*type: "boolean"/);
  const handler = api.slice(api.indexOf('if (name === "lifeos_list_tasks")'), api.indexOf('if (name === "lifeos_list_events")'));
  assert.match(handler, /const includeWaiting = input\.include_waiting === true;/, "off unless asked");
  assert.match(handler, /not_before\.is\.null,not_before\.lte\.\$\{todayKey\}/);
  assert.match(handler, /waiting_count:/);
});

test("every ranked surface loads the start date", () => {
  for (const file of [
    "app/(app)/page.tsx",
    "app/(app)/tasks/page.tsx",
    "app/api/cron/brief/route.ts",
    "lib/tasks/trip-steps.ts",
    "lib/assistant/context.ts",
  ]) {
    assert.match(src(file), /not_before/, file);
  }
});

// --- 6. the one-off report ----------------------------------------------------

test("namedFuturePeriod finds next month's work and leaves this month's alone", () => {
  const today = "2026-09-27";
  assert.equal(namedFuturePeriod("Raise AICA invoice for October", today), "October 2026");
  assert.equal(namedFuturePeriod("November invoice", today), "November 2026");
  assert.equal(namedFuturePeriod("Raise AICA invoice for September", today), null);
  assert.equal(namedFuturePeriod("Receipts for August trips", today), null);
  assert.equal(namedFuturePeriod("Plan January batches", today), "January 2027", "the nearest January");
  assert.equal(namedFuturePeriod("Renew car insurance 2027", today), "2027");
  assert.equal(namedFuturePeriod("Call Ravi", today), null);
});

test("the report lists premature and repeated tasks and changes nothing", () => {
  const rows: ReportRow[] = [
    { id: "1", title: "Raise AICA invoice for October", status: "todo", due_ts: "2026-11-03T04:00:00Z", not_before: null },
    { id: "2", title: "Raise AICA invoice for September", status: "todo", due_ts: "2026-10-03T04:00:00Z", not_before: null },
    { id: "3", title: "raise the AICA invoice - September", status: "inbox", due_ts: null, not_before: null },
    { id: "4", title: "Raise AICA invoice for November", status: "done", due_ts: null, not_before: null },
  ];
  const out = buildReport(rows, "2026-09-27");
  assert.match(out, /Nothing has been changed/);
  assert.match(out, /future month or year: 1\b/);
  assert.match(out, /Raise AICA invoice for October \| names October 2026/);
  assert.doesNotMatch(out, /invoice for November/, "finished tasks are not reviewed");
  assert.match(out, /repeats of each other: 1 pair\b/);
  assert.match(out, /ids 2, 3/);

  // Read only, provably: one select and nothing that writes.
  const script = src("scripts/report-premature-tasks.ts");
  assert.doesNotMatch(script, /\.(insert|update|upsert|delete|rpc)\(/);
  assert.match(script, /\.select\(/);
});

test("checklist steps of different trips are not reported as repeats", () => {
  const rows: ReportRow[] = [
    { id: "a", title: "Collect cab receipts", status: "todo", due_ts: null, not_before: null, trip_id: "t1" },
    { id: "b", title: "Collect cab receipts", status: "todo", due_ts: null, not_before: null, trip_id: "t2" },
    { id: "c", title: "Collect cab receipts", status: "todo", due_ts: null, not_before: null, trip_id: "t1" },
    { id: "d", title: "Raise the AICA invoice for last month", status: "todo", due_ts: null, not_before: null },
    { id: "e", title: "Raise the AICA invoice for last month", status: "todo", due_ts: null, not_before: null },
  ];
  const out = buildReport(rows, "2026-10-01");
  assert.match(out, /repeats of each other: 2 pairs\b/);
  assert.match(out, /ids a, c/, "same trip is still a repeat");
  assert.match(out, /ids d, e/, "tasks on no trip are still compared");
  assert.doesNotMatch(out, /ids a, b|ids b, c/, "different trips are not repeats");
});

test("no emojis or em dashes in anything B19 wrote", () => {
  for (const file of [
    "lib/tasks/near-duplicate.ts",
    "lib/tasks/triage.ts",
    "lib/tasks/recurring.ts",
    "scripts/report-premature-tasks.ts",
    "supabase/migrations/20260927000100_b19_task_not_before.sql",
  ]) {
    const text = src(file);
    assert.doesNotMatch(text, /\u2014/, `${file} has an em dash`);
    assert.doesNotMatch(text, /\p{Extended_Pictographic}/u, `${file} has an emoji`);
  }
});
