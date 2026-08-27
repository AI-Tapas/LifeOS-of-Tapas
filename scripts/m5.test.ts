// Offline proof for M5 (morning brief + cron). Run: npm run test:m5
// (Node 22.18+, same native TS type-stripping as m3/m4/triage tests.)
//
// Covers: the brief composer's band order/empty-states/subject line against
// the exact triage.ts rules Home uses, the weekend guard's Wed-Fri window,
// the cron bearer-token check, the idempotency guard, and IST date maths at
// the day boundary (including the 23:30 UTC instant named in the M5 brief).

import test from "node:test";
import assert from "node:assert/strict";
import { composeBrief, type BriefTask, type BriefEvent } from "../lib/brief/compose.ts";
import { cronAuthorized, alreadyRanToday } from "../lib/cron/guard.ts";
import { civilKey, civilToday } from "../lib/datetime.ts";

const APP_BASE_URL = "https://life-os-of-tapas.vercel.app";

function task(over: Partial<BriefTask> & Pick<BriefTask, "id" | "title">): BriefTask {
  return {
    priority: "medium",
    due_ts: null,
    status: "todo",
    source: "manual",
    created_at: "2026-01-01T00:00:00Z",
    stream: "Personal",
    ...over,
  };
}

function event(over: Partial<BriefEvent> & Pick<BriefEvent, "id" | "title" | "start_ts">): BriefEvent {
  return {
    all_day: false,
    account_slot: "ca_tapasnr",
    account_label: "ca.tapasnr@gmail.com",
    ...over,
  };
}

const NOW = Date.parse("2026-08-25T06:00:00Z"); // 11:30 am IST Tuesday, same fixed instant as triage.test.ts

// --- band order and empty states --------------------------------------

test("bands render in do_first, important, urgent order and later is never shown", () => {
  const tasks = [
    task({ id: "a", title: "Overdue and high", priority: "high", due_ts: "2026-08-01T00:00:00Z" }), // do_first
    task({ id: "b", title: "High no deadline", priority: "high", due_ts: null }), // important
    task({ id: "c", title: "Low due soon", priority: "low", due_ts: "2026-08-25T12:00:00Z" }), // urgent (within 48h)
    task({ id: "d", title: "Low far off, never shown", priority: "low", due_ts: "2026-12-01T00:00:00Z" }), // later
  ];
  const { text } = composeBrief({
    nowMs: NOW,
    tasks,
    events: [],
    pendingApprovalsCount: 0,
    accountsNeedingReconnect: [],
    appBaseUrl: APP_BASE_URL,
  });
  const iDoFirst = text.indexOf("Do first:");
  const iImportant = text.indexOf("Important, not urgent:");
  const iUrgent = text.indexOf("Urgent, less important:");
  assert.ok(iDoFirst >= 0 && iImportant > iDoFirst && iUrgent > iImportant, "bands out of order");
  assert.ok(text.includes("Overdue and high"));
  assert.ok(text.includes("High no deadline"));
  assert.ok(text.includes("Low due soon"));
  assert.ok(!text.includes("Low far off, never shown"), "the later band must never appear in the brief");
});

test("no do_first/important/urgent tasks renders Desk clear, not empty band headings", () => {
  const { subject, text } = composeBrief({
    nowMs: NOW,
    tasks: [],
    events: [],
    pendingApprovalsCount: 0,
    accountsNeedingReconnect: [],
    appBaseUrl: APP_BASE_URL,
  });
  assert.equal(subject, "Your day: desk clear");
  assert.ok(text.includes("Desk clear."));
  assert.ok(!text.includes("Do first:"));
  assert.ok(!text.includes("Important, not urgent:"));
  assert.ok(!text.includes("Urgent, less important:"));
});

test("a desk with only later tasks still reads as Desk clear (matches Home's empty check)", () => {
  const { subject } = composeBrief({
    nowMs: NOW,
    tasks: [task({ id: "z", title: "Someday", priority: "low", due_ts: "2026-12-25T00:00:00Z" })],
    events: [],
    pendingApprovalsCount: 0,
    accountsNeedingReconnect: [],
    appBaseUrl: APP_BASE_URL,
  });
  assert.equal(subject, "Your day: desk clear");
});

// --- subject line --------------------------------------------------------

test("subject line names the top band's first item, truncated past 80 chars", () => {
  const longTitle = "Confirm the September AICA course schedule change with ICAI before the deadline slips";
  const { subject } = composeBrief({
    nowMs: NOW,
    tasks: [task({ id: "a", title: longTitle, priority: "high", due_ts: "2026-08-01T00:00:00Z" })],
    events: [],
    pendingApprovalsCount: 0,
    accountsNeedingReconnect: [],
    appBaseUrl: APP_BASE_URL,
  });
  assert.ok(subject.startsWith("Your day: "));
  // truncate() keeps the first 79 chars and appends "...", so a truncated
  // item is at most 82 chars.
  assert.ok(subject.length <= "Your day: ".length + 82);
  assert.ok(subject.endsWith("..."));
});

// --- weekend guard, Wednesday through Friday only -------------------------

const WEEKDAY_CASES: Array<[string, string, boolean]> = [
  ["2026-08-25T06:00:00Z", "Tuesday", false],
  ["2026-08-26T06:00:00Z", "Wednesday", true],
  ["2026-08-27T06:00:00Z", "Thursday", true],
  ["2026-08-28T06:00:00Z", "Friday", true],
  ["2026-08-29T06:00:00Z", "Saturday", false],
  ["2026-09-01T06:00:00Z", "Tuesday (next week)", false],
];

for (const [iso, label, shouldFire] of WEEKDAY_CASES) {
  test(`weekend guard on ${label} ${shouldFire ? "fires" : "stays quiet"}`, () => {
    const nowMs = Date.parse(iso);
    const { text } = composeBrief({
      nowMs,
      tasks: [task({ id: "sat", title: "Weekend deadline", priority: "low", due_ts: "2026-08-29T04:00:00Z" })],
      events: [],
      pendingApprovalsCount: 0,
      accountsNeedingReconnect: [],
      appBaseUrl: APP_BASE_URL,
    });
    assert.equal(text.includes("Weekend at risk"), shouldFire);
  });
}

// --- today's events, approvals, reconnect notices -------------------------

test("no events today renders the same empty copy as Home", () => {
  const { text } = composeBrief({
    nowMs: NOW,
    tasks: [],
    events: [],
    pendingApprovalsCount: 0,
    accountsNeedingReconnect: [],
    appBaseUrl: APP_BASE_URL,
  });
  assert.ok(text.includes("No meetings today. A clear runway for the Do first list."));
});

test("today's events list time, title and account", () => {
  const { text } = composeBrief({
    nowMs: NOW,
    tasks: [],
    events: [event({ id: "e1", title: "AICA committee call", start_ts: "2026-08-25T09:00:00Z", account_label: "Tax Strategia" })],
    pendingApprovalsCount: 0,
    accountsNeedingReconnect: [],
    appBaseUrl: APP_BASE_URL,
  });
  assert.ok(text.includes("AICA committee call"));
  assert.ok(text.includes("Tax Strategia"));
});

test("the app's own reminder events are dropped from Also today, real meetings kept", () => {
  const { html, text } = composeBrief({
    nowMs: NOW,
    tasks: [
      task({ id: "a", title: "File reply to SCN", priority: "high", due_ts: "2026-08-25T12:00:00Z" }),
    ],
    events: [
      event({ id: "e1", title: "File reply to SCN", start_ts: "2026-08-25T12:00:00Z", ext_event_id: "gcal_rem_1" }),
      event({ id: "e2", title: "AICA committee call", start_ts: "2026-08-25T09:00:00Z", ext_event_id: "gcal_meet_2" }),
    ],
    reminderExtEventIds: ["gcal_rem_1"],
    pendingApprovalsCount: 0,
    accountsNeedingReconnect: [],
    appBaseUrl: APP_BASE_URL,
  });
  const alsoToday = text.slice(text.indexOf("Also today:"));
  assert.ok(!alsoToday.includes("File reply to SCN"), "reminder event must not repeat under Also today");
  assert.ok(alsoToday.includes("AICA committee call"), "a real meeting must stay");
  assert.ok(text.includes("File reply to SCN"), "the task itself still ranks in the bands");
  assert.ok(html.includes("Also today"), "html heading renamed");
  assert.ok(!html.includes(">Today<"), "old Today heading gone from html");
});

test("with no reminder id list every event is kept (older callers unaffected)", () => {
  const { text } = composeBrief({
    nowMs: NOW,
    tasks: [],
    events: [event({ id: "e1", title: "AICA committee call", start_ts: "2026-08-25T09:00:00Z", ext_event_id: "gcal_meet_2" })],
    pendingApprovalsCount: 0,
    accountsNeedingReconnect: [],
    appBaseUrl: APP_BASE_URL,
  });
  assert.ok(text.includes("AICA committee call"));
});

test("pending approvals line is omitted at zero and pluralises correctly above one", () => {
  const zero = composeBrief({
    nowMs: NOW,
    tasks: [],
    events: [],
    pendingApprovalsCount: 0,
    accountsNeedingReconnect: [],
    appBaseUrl: APP_BASE_URL,
  });
  assert.ok(!zero.text.includes("waiting for your approval"));

  const one = composeBrief({
    nowMs: NOW,
    tasks: [],
    events: [],
    pendingApprovalsCount: 1,
    accountsNeedingReconnect: [],
    appBaseUrl: APP_BASE_URL,
  });
  assert.ok(one.text.includes("1 item is waiting for your approval"));

  const three = composeBrief({
    nowMs: NOW,
    tasks: [],
    events: [],
    pendingApprovalsCount: 3,
    accountsNeedingReconnect: [],
    appBaseUrl: APP_BASE_URL,
  });
  assert.ok(three.text.includes("3 items are waiting for your approval"));
});

test("an account needing reconnect is named in the brief", () => {
  const { text } = composeBrief({
    nowMs: NOW,
    tasks: [],
    events: [],
    pendingApprovalsCount: 0,
    accountsNeedingReconnect: [{ slot: "altechon", label: "Altechon" }],
    appBaseUrl: APP_BASE_URL,
  });
  assert.ok(text.includes("Altechon needs reconnecting"));
});

// --- "from last night's mail scan" section --------------------------------

test("a task the 03:00 IST scan created shows up in the 07:00 IST brief's scan section", () => {
  // Realistic pipeline timing: the scan cron fires at 21:30 UTC (03:00 IST)
  // and creates the task then; the brief cron fires at 01:30 UTC the same
  // IST morning (07:00 IST). Both land in the same IST calendar day.
  const scannedAt = "2026-08-28T21:30:00Z"; // 03:00 IST, 29 Aug
  const briefRunsAt = Date.parse("2026-08-29T01:30:00Z"); // 07:00 IST, 29 Aug
  const { text } = composeBrief({
    nowMs: briefRunsAt,
    tasks: [task({ id: "s1", title: "Plant and machinery insurance renewal", source: "email", created_at: scannedAt })],
    events: [],
    pendingApprovalsCount: 0,
    accountsNeedingReconnect: [],
    appBaseUrl: APP_BASE_URL,
  });
  assert.ok(text.includes("From last night's mail scan:"));
  assert.ok(text.includes("Plant and machinery insurance renewal"));
});

test("an older email-sourced task from before today's IST midnight is not in the scan section", () => {
  const briefRunsAt = Date.parse("2026-08-29T01:30:00Z"); // 07:00 IST, 29 Aug
  const oldScan = "2026-08-27T10:00:00Z"; // two IST days earlier
  const { text } = composeBrief({
    nowMs: briefRunsAt,
    tasks: [task({ id: "old", title: "Old scanned task, not from last night", source: "email", created_at: oldScan })],
    events: [],
    pendingApprovalsCount: 0,
    accountsNeedingReconnect: [],
    appBaseUrl: APP_BASE_URL,
  });
  assert.ok(!text.includes("From last night's mail scan:"));
  assert.ok(!text.includes("Old scanned task, not from last night"));
});

// --- cron bearer auth ------------------------------------------------------

test("cronAuthorized", () => {
  process.env.CRON_SECRET = "a".repeat(32);
  assert.equal(cronAuthorized(`Bearer ${"a".repeat(32)}`), true);
  assert.equal(cronAuthorized(`Bearer ${"b".repeat(32)}`), false);
  assert.equal(cronAuthorized(null), false);
  assert.equal(cronAuthorized(""), false);
  // No "Bearer " prefix to strip, but the raw value still matches byte for
  // byte: same precedent as the existing LIFEOS_MCP_TOKEN check, which only
  // strips a prefix if one is present rather than requiring it.
  assert.equal(cronAuthorized("a".repeat(32)), true);

  delete process.env.CRON_SECRET;
  assert.equal(cronAuthorized(`Bearer ${"a".repeat(32)}`), false, "no secret configured must always refuse");

  process.env.CRON_SECRET = "short";
  assert.equal(cronAuthorized("Bearer short"), false, "a secret under 24 chars is refused as too weak");
  delete process.env.CRON_SECRET;
});

// --- idempotency guard -------------------------------------------------

test("alreadyRanToday", () => {
  assert.equal(alreadyRanToday([], "2026-08-29"), false);
  assert.equal(alreadyRanToday([{ meta: { ist_date: "2026-08-29" } }], "2026-08-29"), true);
  assert.equal(
    alreadyRanToday([{ meta: { ist_date: "2026-08-29" } }], "2026-08-30"),
    false,
    "a new IST day is not blocked by yesterday's success row"
  );
  assert.equal(alreadyRanToday([{ meta: {} }, { meta: null }], "2026-08-29"), false);
});

// --- IST date maths at the day boundary ------------------------------------

test("civilToday resolves the IST calendar day, not the UTC one, across the midnight boundary", () => {
  // IST midnight (00:00 IST) is 18:30 UTC the previous day.
  assert.equal(civilKey(civilToday(Date.parse("2026-08-28T18:29:00Z"))), "2026-08-28", "23:59 IST, still the 28th");
  assert.equal(civilKey(civilToday(Date.parse("2026-08-28T18:30:00Z"))), "2026-08-29", "00:00 IST, rolls to the 29th");
  // 21:30 UTC is the night-scan cron's own fire time (03:00 IST).
  assert.equal(civilKey(civilToday(Date.parse("2026-08-28T21:30:00Z"))), "2026-08-29");
  // The instant named explicitly in the M5 brief: 23:30 UTC (05:00 IST),
  // well inside the new IST day.
  assert.equal(civilKey(civilToday(Date.parse("2026-08-28T23:30:00Z"))), "2026-08-29");
});
