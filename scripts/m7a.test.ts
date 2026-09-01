// Offline proof for Milestone 7a: the calendar is for interrupts, not for the
// whole task list. Run: npm run test:m7a (Node 22.18+, the same native TS
// type-stripping as the m3/m4/m5/m6/m6b/m6c/b3 suites). No network, no
// database: pure logic and source-shape checks only.
//
// What is proven here:
//   1. The mode each generator chooses, by the KIND of work: every trip
//      checklist step is in_app, the overseas chapter AED step is not, and
//      the recurring monthly invoice task is switched to in_app by the
//      migration.
//   2. Switching a task between the two modes creates and removes the Google
//      Calendar event exactly once, in either direction, and never leaves an
//      orphan behind.
//   3. An in_app task still ranks on Home and still appears in the morning
//      brief. Nothing disappears from the app.
//   4. A trip writes ONE all-day event spanning the right dates, with a
//      single reminder the day before.
//   5. No tool schema can set reminder_mode to anything outside the two
//      values, and the executor validates it rather than trusting the wire.
//   6. The one-off cleanup is owner-session maintenance: it is on no tool
//      surface, and it is safe to run twice.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  REMINDER_MODES,
  buildTripEvent,
  isReminderMode,
  nextDateKey,
  planTaskReminder,
  runReminderCleanup,
  tripEventTitle,
  TRIP_REMINDER_MINUTES,
  type ReminderMode,
} from "../lib/reminders/core.ts";
import { buildChecklist, type ChecklistTrip } from "../lib/trips/checklist.ts";
import { triage } from "../lib/tasks/triage.ts";
import { composeBrief, type BriefTask } from "../lib/brief/compose.ts";
import { TOOLS, SCAN_TOOL, toolByName } from "../lib/assistant/tools.ts";

const src = (rel: string): string =>
  readFileSync(new URL("../" + rel, import.meta.url), "utf8");

const TODAY = "2026-08-01";
const NOW = Date.parse("2026-08-25T06:00:00Z"); // 11:30 am IST Tuesday

const TRIP: ChecklistTrip = {
  title: "AICA session, Rajkot branch",
  purpose: "aica",
  start_date: "2026-09-03",
  end_date: "2026-09-04",
  bills_to: "icai_monthly",
  cities: ["Rajkot"],
  hotel_arrangement: "branch",
};

// --- 1. what each generator chooses, by the kind of work --------------------

test("every ordinary trip checklist step stays off the calendar", () => {
  const steps = buildChecklist(TRIP, TODAY);
  assert.deepEqual(
    steps.map((s) => s.key),
    ["onward", "return", "hotel", "receipts"]
  );
  for (const step of steps) {
    assert.equal(
      step.reminder_mode,
      "in_app",
      step.key + " is routine travel admin and must not interrupt him"
    );
  }
});

test("the self-booked hotel step is routine too, whatever the arrangement", () => {
  for (const hotel of ["branch", "self"] as const) {
    const step = buildChecklist({ ...TRIP, hotel_arrangement: hotel }, TODAY).find(
      (s) => s.key === "hotel"
    )!;
    assert.equal(step.reminder_mode, "in_app", hotel);
  }
});

test("the overseas chapter AED invoice keeps its calendar reminder", () => {
  const steps = buildChecklist(
    { ...TRIP, bills_to: "chapter_aed", cities: ["Dubai"] },
    TODAY
  );
  const aed = steps.find((s) => s.key === "aed")!;
  assert.match(aed.title, /AED invoice/);
  assert.equal(
    aed.reminder_mode,
    "calendar",
    "once or twice a year, and forgetting it is the stated risk"
  );
  // and it is still the ONLY one on the calendar in that list
  assert.deepEqual(
    steps.filter((s) => s.reminder_mode === "calendar").map((s) => s.key),
    ["aed"]
  );
});

test("the seeder hands each step its own mode, rather than deciding again", () => {
  const w = src("lib/trips/write.ts");
  assert.ok(
    w.includes("reminder_mode: step.reminder_mode"),
    "seedTripChecklist must carry the step's own mode"
  );
});

test("the recurring monthly invoice task is switched to in_app by the migration", () => {
  const m = src("supabase/migrations/20260901000400_m7a_reminder_mode.sql");
  assert.match(
    m,
    /update tasks\s+set reminder_mode = 'in_app'\s+where title = 'Raise the AICA invoice for last month'/,
    "the monthly invoice task has a standing place in his month"
  );
  // Checklist steps go with it, minus the AED one.
  assert.match(
    m,
    /where trip_id is not null\s+and title not like 'Raise the AED invoice%'/
  );
});

test("a completed occurrence hands its mode to the next one", () => {
  // Otherwise the monthly invoice task quietly returns to the calendar the
  // first time he completes it.
  const w = src("lib/tasks/write.ts");
  assert.ok(w.includes("reminder_mode: t.reminder_mode"));
});

test("his own tasks and mail-derived tasks still default to the calendar", () => {
  const w = src("lib/tasks/write.ts");
  assert.ok(
    w.includes('reminder_mode: input.reminder_mode ?? "calendar"'),
    "the default must be today's behaviour, so nothing existing changes meaning"
  );
  const scan = src("lib/assistant/scan.ts");
  assert.equal(
    scan.includes("reminder_mode"),
    false,
    "mail-derived work is usually somebody waiting on him: it stays on the calendar"
  );
});

// --- 2. switching modes, exactly once, in both directions -------------------

test("in_app removes, calendar writes, and the older reasons still hold", () => {
  const base = { due_ts: "2026-09-03T04:00:00Z", status: "todo" };
  assert.equal(planTaskReminder({ ...base, reminder_mode: "calendar" }), "write");
  assert.equal(planTaskReminder({ ...base, reminder_mode: "in_app" }), "remove");
  // A row written before this milestone has no mode and must still remind.
  assert.equal(planTaskReminder({ ...base, reminder_mode: null }), "write");
  assert.equal(planTaskReminder(base), "write");
  // The pre-existing reasons to have no reminder still hold, mode or not.
  assert.equal(
    planTaskReminder({ ...base, due_ts: null, reminder_mode: "calendar" }),
    "remove"
  );
  for (const status of ["done", "dropped"]) {
    assert.equal(
      planTaskReminder({ ...base, status, reminder_mode: "calendar" }),
      "remove"
    );
  }
});

// A miniature of the writer: one Google calendar, one reminders row, and the
// same two paths the real writer takes (create or patch on "write", the
// shared runReminderCleanup on "remove"). It proves the ORCHESTRATION, which
// is what leaves an orphan when it is wrong; the provider calls are mocked.
function harness() {
  const calendar = new Map<string, string>(); // ext event id -> title
  let rows: { id: string; ext_event_id: string | null }[] = [];
  let created = 0;
  let deleted = 0;
  let nextId = 1;

  async function sync(task: {
    reminder_mode?: ReminderMode | null;
    due_ts: string | null;
    status: string;
  }) {
    if (planTaskReminder(task) === "remove") {
      await runReminderCleanup({
        load: async () => rows,
        deleteEvent: async (extId) => {
          assert.ok(calendar.has(extId), "must not delete an event twice");
          calendar.delete(extId);
          deleted += 1;
        },
        deleteRow: async (id) => {
          rows = rows.filter((r) => r.id !== id);
        },
      });
      return;
    }
    const existing = rows[0];
    if (existing?.ext_event_id) {
      calendar.set(existing.ext_event_id, "Reminder: Book onward ticket");
      return; // patched, never created a second time
    }
    const extId = "evt_" + nextId++;
    calendar.set(extId, "Reminder: Book onward ticket");
    created += 1;
    rows = [{ id: "rem_" + nextId, ext_event_id: extId }];
  }

  return { sync, counts: () => ({ created, deleted, onCalendar: calendar.size }) };
}

test("calendar to in_app removes the event once, and stays removed", async () => {
  const h = harness();
  const task = { due_ts: "2026-09-03T04:00:00Z", status: "todo" };
  await h.sync({ ...task, reminder_mode: "calendar" });
  assert.deepEqual(h.counts(), { created: 1, deleted: 0, onCalendar: 1 });

  await h.sync({ ...task, reminder_mode: "in_app" });
  assert.deepEqual(h.counts(), { created: 1, deleted: 1, onCalendar: 0 });

  // Saving the task again must not try to delete a second time.
  await h.sync({ ...task, reminder_mode: "in_app" });
  assert.deepEqual(h.counts(), { created: 1, deleted: 1, onCalendar: 0 });
});

test("in_app to calendar creates exactly one event, not one per save", async () => {
  const h = harness();
  const task = { due_ts: "2026-09-03T04:00:00Z", status: "todo" };
  await h.sync({ ...task, reminder_mode: "in_app" });
  assert.deepEqual(h.counts(), { created: 0, deleted: 0, onCalendar: 0 });

  await h.sync({ ...task, reminder_mode: "calendar" });
  await h.sync({ ...task, reminder_mode: "calendar" });
  assert.deepEqual(h.counts(), { created: 1, deleted: 0, onCalendar: 1 });
});

test("the writer routes both directions through the one removal path", () => {
  const w = src("lib/reminders/writer.ts");
  assert.ok(w.includes('planTaskReminder(task) === "remove"'));
  // One removal implementation. A second delete path is exactly how an
  // orphan event gets left behind.
  assert.equal(
    (w.match(/async function removeReminder\(/g) ?? []).length,
    1,
    "there must be exactly one removeReminder"
  );
});

// --- 3. nothing disappears from the app -------------------------------------

test("an in_app task still ranks on Home", () => {
  const ranked = triage(
    [
      {
        id: "step",
        title: "Book onward ticket",
        priority: "high",
        due_ts: "2026-08-25T04:00:00Z",
        status: "todo",
      },
    ],
    NOW
  );
  assert.equal(ranked.do_first.length, 1, "the ranking reads tasks, not reminders");
  assert.equal(ranked.do_first[0].title, "Book onward ticket");
});

test("an in_app task still appears in the morning brief", () => {
  const step: BriefTask = {
    id: "step",
    title: "Book onward ticket",
    priority: "high",
    due_ts: "2026-08-25T04:00:00Z",
    status: "todo",
    source: "manual",
    created_at: "2026-08-01T00:00:00Z",
    stream: "ICAI",
  };
  const { text } = composeBrief({
    nowMs: NOW,
    tasks: [step],
    events: [],
    pendingApprovalsCount: 0,
    accountsNeedingReconnect: [],
    appBaseUrl: "https://life-os-of-tapas.vercel.app",
  });
  assert.ok(text.includes("Book onward ticket"), "the brief reaches him either way");
});

test("the brief and Home read tasks, never how a task reminds him", () => {
  for (const file of ["lib/brief/compose.ts", "lib/tasks/triage.ts"]) {
    assert.equal(
      src(file).includes("reminder_mode"),
      false,
      file + " must not filter on how a task reminds him"
    );
  }
});

// --- 4. one trip, one all-day entry -----------------------------------------

test("a trip is ONE all-day event spanning its dates", () => {
  const e = buildTripEvent({
    title: "AICA session, Rajkot branch",
    cities: ["Rajkot"],
    startDate: "2026-09-03",
    endDate: "2026-09-04",
  });
  assert.deepEqual(e.start, { date: "2026-09-03" });
  // Google treats the end date as exclusive, so a 3rd-to-4th trip ends on the 5th.
  assert.deepEqual(e.end, { date: "2026-09-05" });
  assert.equal("dateTime" in e.start, false, "an all-day event carries no time");
});

test("a same-day trip still covers its one square", () => {
  const e = buildTripEvent({
    title: "Surat day return",
    cities: ["Surat"],
    startDate: "2026-09-10",
  });
  assert.deepEqual(e.start, { date: "2026-09-10" });
  assert.deepEqual(e.end, { date: "2026-09-11" });
});

test("an end date before the start never produces a backwards event", () => {
  const e = buildTripEvent({
    title: "Typo trip",
    cities: [],
    startDate: "2026-09-10",
    endDate: "2026-09-01",
  });
  assert.deepEqual(e.end, { date: "2026-09-11" });
});

test("a trip reminds once, the day before, not with the four-offset set", () => {
  const e = buildTripEvent({
    title: "AICA session",
    cities: ["Rajkot"],
    startDate: "2026-09-03",
  });
  assert.equal(e.reminders.useDefault, false);
  assert.deepEqual(e.reminders.overrides, [
    { method: "popup", minutes: TRIP_REMINDER_MINUTES },
  ]);
  assert.equal(
    TRIP_REMINDER_MINUTES,
    900,
    "15 hours back from midnight is 9 am the day before"
  );
});

test("the title carries the city, without saying it twice", () => {
  assert.equal(
    tripEventTitle("AICA session, Rajkot branch", ["Rajkot"]),
    "AICA session, Rajkot branch"
  );
  assert.equal(tripEventTitle("AICA session", ["Rajkot"]), "AICA session (Rajkot)");
  assert.equal(tripEventTitle("AICA session", []), "AICA session");
});

test("month ends roll over correctly", () => {
  assert.equal(nextDateKey("2026-09-30"), "2026-10-01");
  assert.equal(nextDateKey("2026-12-31"), "2027-01-01");
  assert.equal(nextDateKey("2028-02-28"), "2028-02-29"); // leap year
});

test("the trip event uses the existing reminder-home path, not a second one", () => {
  const w = src("lib/reminders/writer.ts");
  assert.ok(w.includes("export async function syncTripEvent"));
  const trip = w.slice(w.indexOf("export async function syncTripEvent"));
  assert.ok(trip.includes("resolveReminderHome"), "one reminder-home rule");
  assert.ok(trip.includes("gcalCreate") && trip.includes("gcalPatch"));
  assert.equal(
    (w.match(/withResourceAuth\(/g) ?? []).length,
    3,
    "create, patch and delete: no fourth provider path was added"
  );
});

test("the trip event moves with the dates and goes with the trip", () => {
  const w = src("lib/trips/write.ts");
  assert.ok(w.includes("await syncTripEvent(userId, id)"), "updateTrip re-syncs the span");
  const del = w.slice(w.indexOf("export async function deleteTrip"));
  const removeAt = del.indexOf("removeTripEvent");
  const deleteAt = del.indexOf('.from("trips").delete()');
  assert.ok(removeAt > -1 && deleteAt > removeAt, "remove the event BEFORE the row");
});

// --- 5. the tool surface cannot invent a third mode -------------------------

test("no tool schema can set reminder_mode outside the two values", () => {
  let seen = 0;
  const walk = (node: unknown, path: string): void => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) {
      node.forEach((n, i) => walk(n, path + "[" + i + "]"));
      return;
    }
    const obj = node as Record<string, unknown>;
    const props = obj.properties as Record<string, unknown> | undefined;
    const mode = props?.reminder_mode as Record<string, unknown> | undefined;
    if (mode) {
      seen += 1;
      assert.equal(mode.type, "string", path + ".reminder_mode must be one concrete type");
      assert.equal(Array.isArray(mode.type), false, "no nullable union, the house rule");
      assert.deepEqual(
        mode.enum,
        ["calendar", "in_app"],
        path + ".reminder_mode must offer exactly the two real values"
      );
    }
    for (const [k, v] of Object.entries(obj)) walk(v, path + "." + k);
  };
  for (const t of [...TOOLS, SCAN_TOOL]) walk(t.input_schema, t.name);
  assert.equal(seen, 2, "create_task and update_task, and nothing else");

  // It is optional everywhere it appears: omitting it keeps the default.
  for (const name of ["create_task", "update_task"]) {
    const s = toolByName(name)!.input_schema as unknown as { required: string[] };
    assert.equal(s.required.includes("reminder_mode"), false, name);
  }
});

test("the executor validates the mode instead of trusting the wire", () => {
  assert.equal(isReminderMode("calendar"), true);
  assert.equal(isReminderMode("in_app"), true);
  for (const bad of ["gcal", "none", "", null, undefined, 1, {}, ["calendar"]]) {
    assert.equal(isReminderMode(bad), false, JSON.stringify(bad) ?? "undefined");
  }
  assert.deepEqual(REMINDER_MODES, ["calendar", "in_app"]);
  const e = src("lib/assistant/execute.ts");
  assert.equal(
    (e.match(/isReminderMode\(input\.reminder_mode\)/g) ?? []).length,
    2,
    "both task performers must guard the value"
  );
});

// --- 6. the one-off cleanup is maintenance, not a tool ----------------------

test("the cleanup is on no tool surface", () => {
  for (const t of [...TOOLS, SCAN_TOOL]) {
    assert.equal(
      /cleanup|sweep|clear_/.test(t.name),
      false,
      t.name + " must not be a maintenance tool"
    );
  }
  for (const file of [
    "lib/assistant/tools.ts",
    "lib/assistant/execute.ts",
    "lib/assistant/mcp-api.ts",
  ]) {
    assert.equal(
      src(file).includes("sweepInAppReminderEvents"),
      false,
      file + " must not reach the maintenance sweep"
    );
  }
});

test("the cleanup runs from an owner session only, and never on deploy", () => {
  const a = src("app/(app)/settings/actions.ts");
  const action = a.slice(
    a.indexOf("export async function clearInAppCalendarEntriesAction")
  );
  assert.ok(action.includes('requireUser("/settings")'), "owner session gate");
  assert.ok(action.includes("sweepInAppReminderEvents(user.id)"));
  // Nothing schedules it.
  for (const file of [
    "vercel.json",
    "app/api/cron/brief/route.ts",
    "app/api/cron/scan/route.ts",
  ]) {
    assert.equal(src(file).includes("InAppCalendarEntries"), false, file);
    assert.equal(src(file).includes("sweepInAppReminderEvents"), false, file);
  }
});

test("the sweep only touches in_app tasks, so it is safe to run twice", () => {
  const w = src("lib/reminders/writer.ts");
  const sweep = w.slice(w.indexOf("export async function sweepInAppReminderEvents"));
  assert.ok(sweep.includes('.not("ext_event_id", "is", null)'), "only rows with an event");
  assert.ok(sweep.includes('mode !== "in_app"'), "never touches a calendar task");
  assert.ok(sweep.includes("removeReminder("), "the normal removal path, not a bespoke delete");
});
