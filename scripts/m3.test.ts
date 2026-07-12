// Pure-logic proof for Milestone 3: reminder offsets mapping, the reminder-home
// structural guard, cleanup with the stored ext_event_id, the attendee
// confirmation gate, and the obligation RRULE. No network, no DB: the same
// offline pattern as scripts/oauth.test.ts. Run: npm run test:m3 (Node 22.18+).
import test from "node:test";
import assert from "node:assert/strict";
import {
  offsetsDaysToMinutes,
  buildReminderOverrides,
  buildGoogleReminderEvent,
  obligationRRule,
  assertReminderHome,
  runReminderCleanup,
} from "../lib/reminders/core.ts";
import {
  prepareEventWrite,
  requireConfirmationIfAttendees,
  ConfirmationRequiredError,
  parseGoogleEvent,
  parseGraphEvent,
  type AppEventInput,
} from "../lib/events/payload.ts";

// --- offsets mapping: days -> minute overrides on ONE event ------------------

test("offsets {7,3,1,0} days map to overrides [10080,4320,1440,0]", () => {
  assert.deepEqual(offsetsDaysToMinutes([7, 3, 1, 0]), [10080, 4320, 1440, 0]);
});

test("a reminder is ONE event carrying four overrides, not four events", () => {
  const event = buildGoogleReminderEvent({
    title: "GST return due",
    startDateTime: "2026-07-20T09:00:00+05:30",
    endDateTime: "2026-07-20T09:15:00+05:30",
    offsetsDays: [7, 3, 1, 0],
  });
  assert.equal(Array.isArray(event), false, "one event object, not an array");
  assert.equal(event.reminders.useDefault, false);
  assert.deepEqual(
    event.reminders.overrides.map((o) => o.minutes),
    [10080, 4320, 1440, 0]
  );
  assert.ok(
    event.reminders.overrides.every((o) => o.method === "popup"),
    "all overrides are popup notifications"
  );
});

test("offsets mapping validates Google limits (<=5 overrides, <=28 days)", () => {
  // 40 days is beyond Google's 28-day cap and is dropped; duplicates removed;
  // capped at five and sorted earliest-first.
  assert.deepEqual(
    offsetsDaysToMinutes([40, 7, 7, 3, 2, 1, 0]),
    [7, 3, 2, 1, 0].map((d) => d * 1440)
  );
  assert.equal(buildReminderOverrides([7, 3, 1, 0]).length, 4);
});

// --- reminder-home structural guard -----------------------------------------

test("the reminder writer refuses any calendar that is not the reminder-home", () => {
  assert.throws(
    () =>
      assertReminderHome({
        id: "cal_other",
        account_id: "acc_x",
        is_reminder_home: false,
      }),
    /reminder-home/
  );
  assert.throws(() => assertReminderHome(null), /reminder-home/);
  // The real reminder-home passes.
  assert.doesNotThrow(() =>
    assertReminderHome({
      id: "cal_home",
      account_id: "acc_ca",
      is_reminder_home: true,
    })
  );
});

// --- cleanup deletes the stored Google event before the row ------------------

test("completion / drop / delete cleans up using the stored ext_event_id", async () => {
  const deletedEvents: string[] = [];
  const deletedRows: string[] = [];
  const result = await runReminderCleanup({
    load: async () => [
      { id: "rem_1", ext_event_id: "gcal_evt_123" },
      { id: "rem_2", ext_event_id: null }, // never created on Google
    ],
    deleteEvent: async (extId) => {
      deletedEvents.push(extId);
    },
    deleteRow: async (id) => {
      deletedRows.push(id);
    },
  });
  assert.deepEqual(deletedEvents, ["gcal_evt_123"], "deletes only the created event");
  assert.deepEqual(deletedRows, ["rem_1", "rem_2"], "closes out both rows");
  assert.deepEqual(result, { deletedEvents: 1, deletedRows: 2 });
});

// --- attendee confirmation gate (enforced in the write path, not just the UI) -

const soloEvent: AppEventInput = {
  title: "Draft reply to ABC Pvt Ltd",
  startIso: "2026-07-15T05:30:00.000Z",
};
const inviteEvent: AppEventInput = {
  title: "Hearing prep call",
  startIso: "2026-07-15T05:30:00.000Z",
  attendees: [{ email: "counsel@example.com" }, { email: "client@example.com" }],
};

test("the write path refuses an attendee-bearing payload without confirmation", () => {
  assert.throws(
    () => prepareEventWrite("google", inviteEvent, false),
    ConfirmationRequiredError
  );
  assert.throws(
    () => prepareEventWrite("microsoft", inviteEvent, false),
    ConfirmationRequiredError
  );
});

test("a confirmed invite passes and carries the attendees through", () => {
  const g = prepareEventWrite("google", inviteEvent, true) as {
    attendees?: unknown[];
  };
  assert.equal(g.attendees?.length, 2);
  const m = prepareEventWrite("microsoft", inviteEvent, true) as {
    attendees?: unknown[];
  };
  assert.equal(m.attendees?.length, 2);
});

test("a solo event (no attendees) needs no confirmation", () => {
  assert.doesNotThrow(() => requireConfirmationIfAttendees(soloEvent, false));
  assert.doesNotThrow(() => prepareEventWrite("google", soloEvent, false));
});

// --- obligation frequency + due day -> RRULE --------------------------------

test("obligation frequency and due day map to the correct RRULE", () => {
  assert.equal(obligationRRule("monthly", 15, null), "RRULE:FREQ=MONTHLY;BYMONTHDAY=15");
  assert.equal(
    obligationRRule("bi_monthly", 5, null),
    "RRULE:FREQ=MONTHLY;INTERVAL=2;BYMONTHDAY=5"
  );
  assert.equal(
    obligationRRule("quarterly", 1, null),
    "RRULE:FREQ=MONTHLY;INTERVAL=3;BYMONTHDAY=1"
  );
  assert.equal(
    obligationRRule("half_yearly", 10, null),
    "RRULE:FREQ=MONTHLY;INTERVAL=6;BYMONTHDAY=10"
  );
  assert.equal(
    obligationRRule("yearly", 15, 4),
    "RRULE:FREQ=YEARLY;BYMONTH=4;BYMONTHDAY=15"
  );
});

test("obligation RRULE rejects a missing due day (and yearly needs a month)", () => {
  assert.throws(() => obligationRRule("monthly", null, null), /due day/);
  assert.throws(() => obligationRRule("yearly", 15, null), /due month/);
});

// --- provider parsers (sync read path) --------------------------------------

test("parseGoogleEvent handles cancelled, timed and all-day events", () => {
  assert.deepEqual(parseGoogleEvent({ id: "e1", status: "cancelled" }), {
    kind: "delete",
    ext_event_id: "e1",
  });
  const timed = parseGoogleEvent({
    id: "e2",
    summary: "Sync call",
    start: { dateTime: "2026-07-20T09:00:00+05:30" },
    end: { dateTime: "2026-07-20T10:00:00+05:30" },
  });
  assert.equal(timed?.kind, "upsert");
  assert.equal(timed && "all_day" in timed && timed.all_day, false);
  assert.equal(
    timed && "start_ts" in timed && timed.start_ts,
    "2026-07-20T03:30:00.000Z"
  );
  const allDay = parseGoogleEvent({
    id: "e3",
    summary: "Holiday",
    start: { date: "2026-08-15" },
    end: { date: "2026-08-16" },
  });
  assert.equal(allDay && "all_day" in allDay && allDay.all_day, true);
});

test("parseGraphEvent handles removed and timed events", () => {
  assert.deepEqual(parseGraphEvent({ id: "m1", "@removed": { reason: "deleted" } }), {
    kind: "delete",
    ext_event_id: "m1",
  });
  const timed = parseGraphEvent({
    id: "m2",
    subject: "Board sync",
    start: { dateTime: "2026-07-20T04:00:00.0000000", timeZone: "UTC" },
    end: { dateTime: "2026-07-20T05:00:00.0000000", timeZone: "UTC" },
  });
  assert.equal(timed?.kind, "upsert");
  assert.equal(
    timed && "start_ts" in timed && timed.start_ts,
    "2026-07-20T04:00:00.000Z"
  );
});
