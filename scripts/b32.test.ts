// B32 offline proof: hours on tasks against the monthly target.
// Run: npm run test:b32. Synthetic data only; the real executor and connector
// read run against the b26 in-memory database.

import { register } from "node:module";
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseHours } from "../lib/hours/parse.ts";
import {
  monthHours,
  lastWeekHours,
  hoursBriefLine,
  homeHoursLine,
  missingHoursLine,
  workingDays,
  type HoursTask,
} from "../lib/hours/month.ts";
import { composeBrief } from "../lib/brief/compose.ts";
import { MCP_READ_TOOLS, TOOLS, schemaStats, toolByName } from "../lib/assistant/tools.ts";
import { db, resetDb } from "./b26-stubs.ts";

register("./b26-loader.mjs", import.meta.url);
const { executeToolCall, undoExecutedAction } = await import("../lib/assistant/execute.ts");
const { runReadTool, READ_TOOL_SCHEMAS } = await import("../lib/assistant/mcp-api.ts");

const src = (rel: string) => readFileSync(new URL("../" + rel, import.meta.url), "utf8");
const EM_DASH = String.fromCharCode(8212);
const DAY = 86400000;
const MON_12_OCT = Date.UTC(2026, 9, 12, 1, 30); // Monday, 7 am IST

function task(over: Partial<HoursTask> = {}): HoursTask {
  return {
    id: "t1",
    status: "done",
    completed_at: new Date(MON_12_OCT - 2 * DAY).toISOString(),
    hours_spent: 2,
    billable: null,
    recurring_rule: null,
    trip_id: null,
    stream_name: "Stream A",
    stream_billable: true,
    ...over,
  };
}

test("input parsing: decimals and clock form agree; bad input is refused", () => {
  assert.deepEqual(parseHours("1.5"), { ok: true, value: 1.5 });
  assert.deepEqual(parseHours("1:30"), { ok: true, value: 1.5 });
  assert.deepEqual(parseHours("0:15"), { ok: true, value: 0.25 });
  assert.deepEqual(parseHours(""), { ok: true, value: null });
  assert.deepEqual(parseHours(null), { ok: true, value: null });
  assert.equal(parseHours("-1").ok, false);
  assert.equal(parseHours("abc").ok, false);
  assert.equal(parseHours(600).ok, false);
  assert.equal(parseHours("600").ok, false);
  assert.equal(parseHours("1:75").ok, false);
  assert.equal(parseHours(500).ok, true);
});

test("month summary counts only effectively billable tasks done this IST month", () => {
  const rows = [
    task({ id: "a", hours_spent: 3 }),
    task({ id: "b", hours_spent: 1.5, stream_name: "Stream B" }),
    task({ id: "off", stream_billable: false, hours_spent: 9 }),
    task({ id: "no", billable: false, hours_spent: 9 }),
    task({ id: "rec", recurring_rule: "monthly:1", hours_spent: 9 }),
    task({ id: "trip", trip_id: "x", hours_spent: 9 }),
    task({ id: "open", status: "todo", hours_spent: 9 }),
    task({ id: "sept", completed_at: new Date(Date.UTC(2026, 8, 30, 12)).toISOString(), hours_spent: 9 }),
  ];
  const s = monthHours(rows, 85, MON_12_OCT);
  assert.equal(s.total, 4.5);
  assert.deepEqual(s.by_stream, [
    { stream: "Stream A", hours: 3 },
    { stream: "Stream B", hours: 1.5 },
  ]);
  assert.equal(s.month, "2026-10");
  assert.equal(s.label, "October 2026");
  assert.equal(s.target, 85);
});

test("11:30 PM IST on the last day belongs to that month; 12:30 AM IST next day does not", () => {
  const lateOct31 = new Date(Date.UTC(2026, 9, 31, 18, 0)).toISOString(); // 23:30 IST
  const earlyNov1 = new Date(Date.UTC(2026, 9, 31, 19, 0)).toISOString(); // 00:30 IST
  const rows = [
    task({ id: "late", completed_at: lateOct31, hours_spent: 2 }),
    task({ id: "next", completed_at: earlyNov1, hours_spent: 5 }),
  ];
  const nov = Date.UTC(2026, 10, 10);
  assert.equal(monthHours(rows, 85, nov, "2026-10").total, 2);
  assert.equal(monthHours(rows, 85, nov).total, 5, "the current month is November");
  assert.equal(monthHours(rows, 85, nov, "2026-10").expected_by_today, 85, "a past month is fully elapsed");
});

test("the missing-hours count is right and 0 hours counts as logged", () => {
  const rows = [
    task({ id: "a", hours_spent: null }),
    task({ id: "b", hours_spent: null }),
    task({ id: "c", hours_spent: 0 }),
    task({ id: "d", hours_spent: null, stream_billable: false }),
    task({ id: "e", hours_spent: null, status: "todo" }),
  ];
  const s = monthHours(rows, 85, MON_12_OCT);
  assert.equal(s.missing_count, 2);
  assert.deepEqual(s.missing_task_ids.sort(), ["a", "b"]);
  assert.equal(missingHoursLine(2), "2 finished billable tasks have no hours");
  assert.equal(missingHoursLine(1), "1 finished billable task has no hours");
  assert.equal(missingHoursLine(0), null);
});

test("pace counts Monday to Saturday only, so Sundays add nothing", () => {
  assert.equal(workingDays(2026, 10, 31), 27, "October 2026 has four Sundays");
  const s = monthHours([], 85, MON_12_OCT);
  assert.equal(s.working_days_elapsed, 10, "12 days less Sundays on the 4th and 11th");
  assert.equal(s.expected_by_today, Math.round(((85 * 10) / 27) * 100) / 100);
  const sunday = monthHours([], 85, Date.UTC(2026, 9, 11, 6));
  assert.equal(sunday.working_days_elapsed, 9, "a Sunday adds no day");
  const end = Date.UTC(2026, 9, 31, 6);
  assert.equal(monthHours([], 85, end).expected_by_today, 85);
  assert.equal(
    homeHoursLine(monthHours([task({ hours_spent: 32.5 })], 85, end)),
    "Billable hours, October: 32.5 of 85 (on pace 85)"
  );
});

function brief(nowMs: number) {
  return composeBrief({
    nowMs,
    tasks: [],
    events: [],
    pendingApprovalsCount: 0,
    accountsNeedingReconnect: [],
    appBaseUrl: "https://example.test",
    hours: { total: 18, pace: 20, missing: 0 },
  });
}

test("the Monday brief line appears only on a Monday", () => {
  assert.match(brief(MON_12_OCT).text, /Billable hours last week: 18 \(target pace 20\)\./);
  assert.match(brief(MON_12_OCT).html, /Billable hours last week: 18/);
  assert.ok(!brief(MON_12_OCT + DAY).text.includes("Billable hours last week"));
  assert.equal(hoursBriefLine(null, MON_12_OCT), null);
});

test("last week is the previous Monday to Sunday in IST, pace is target over 52/12 weeks", () => {
  const inWeek = new Date(Date.UTC(2026, 9, 7, 6)).toISOString(); // Wed 7 Oct
  const sunLate = new Date(Date.UTC(2026, 9, 11, 17, 0)).toISOString(); // Sun 22:30 IST
  const thisWeek = new Date(Date.UTC(2026, 9, 12, 5)).toISOString();
  const before = new Date(Date.UTC(2026, 9, 4, 5)).toISOString();
  const w = lastWeekHours(
    [
      task({ id: "1", completed_at: inWeek, hours_spent: 10 }),
      task({ id: "2", completed_at: sunLate, hours_spent: 8 }),
      task({ id: "3", completed_at: thisWeek, hours_spent: 7 }),
      task({ id: "4", completed_at: before, hours_spent: 7 }),
    ],
    85,
    MON_12_OCT
  );
  assert.deepEqual(w, { total: 18, pace: 20, missing: 0 });
});

// The in-memory database: connector writes and the undo.
function addTask(over: Record<string, unknown> = {}): Record<string, unknown> {
  const r = {
    id: `t-${db.tasks.length + 1}`,
    user_id: "user-1",
    title: "Reply on the notice",
    status: "done",
    source: "manual",
    completed_at: new Date().toISOString(),
    billable: null,
    hours_spent: null,
    recurring_rule: null,
    trip_id: null,
    work_streams: { name: "Stream A", billable: true },
    projects: null,
    ...over,
  };
  db.tasks.push(r);
  return r;
}

test("update_task writes hours, refuses bad hours, and undo restores the previous value", async () => {
  resetDb();
  const t = addTask({ hours_spent: 2 });
  const out = await executeToolCall("update_task", { task_id: t.id, hours_spent: 3.5 });
  assert.equal(t.hours_spent, 3.5);
  assert.ok(db.audit_log.some((a) => a.action === "execute_autonomous"), "audited");
  await assert.rejects(() => executeToolCall("update_task", { task_id: t.id, hours_spent: 600 }), /500/);
  assert.equal(t.hours_spent, 3.5);
  const undone = await undoExecutedAction(String(out.actionId));
  assert.equal(undone.ok, true);
  assert.equal(t.hours_spent, 2, "undo restores the previous hours");
  const fresh = addTask({ hours_spent: null });
  const o2 = await executeToolCall("update_task", { task_id: fresh.id, hours_spent: 1 });
  await undoExecutedAction(String(o2.actionId));
  assert.equal(fresh.hours_spent, null, "undo restores not logged");
});

test("create_task takes hours and lifeos_list_tasks returns them", async () => {
  resetDb();
  db.work_streams.push({ id: "ws-personal", name: "Personal", user_id: "user-1" });
  await executeToolCall("create_task", { title: "Prepare the board note", hours_spent: 1.25 });
  const made = db.tasks.find((t) => t.title === "Prepare the board note")!;
  assert.equal(made.hours_spent, 1.25);
  const r = await runReadTool("lifeos_list_tasks", {});
  const item = (r.items as Record<string, unknown>[]).find((i) => i.id === made.id)!;
  assert.equal(item.hours_spent, 1.25);
});

test("lifeos_get_hours returns the month summary and nothing monetary", async () => {
  resetDb();
  addTask({ id: "h1", hours_spent: 4 });
  addTask({ id: "h2", hours_spent: null });
  const r = await runReadTool("lifeos_get_hours", {});
  assert.equal(r.total, 4);
  assert.equal(r.target, 85);
  assert.equal(r.missing_count, 1);
  assert.ok(!/"(amount|rate|earn|fee|price)[a-z_]*"\s*:/i.test(JSON.stringify(r)), "no money fields");
  await assert.rejects(() => runReadTool("lifeos_get_hours", { month: "October" }), /YYYY-MM/);
  assert.ok((MCP_READ_TOOLS as readonly string[]).includes("lifeos_get_hours"));
  const props = (READ_TOOL_SCHEMAS.lifeos_get_hours as { properties: Record<string, { type: string }> }).properties;
  assert.equal(props.month.type, "string");
});

test("tool schemas: hours_spent is one number type, the description says only when he says so", () => {
  for (const name of ["create_task", "update_task"]) {
    const props = (toolByName(name)!.input_schema as unknown as {
      properties: Record<string, { type: string; description: string }>;
    }).properties;
    assert.equal(props.hours_spent.type, "number");
    assert.match(props.hours_spent.description, /ONLY when he has told you/);
  }
  assert.equal(schemaStats(TOOLS).unions, 0);
});

test("the migration adds the two columns with their checks, and no money", () => {
  const m = src("supabase/migrations/20261004000100_b32_hours_on_tasks.sql");
  assert.match(m, /hours_spent numeric\(5,2\)/);
  assert.match(m, /hours_spent >= 0 and hours_spent <= 500/);
  assert.match(m, /monthly_hours_target integer not null default 85/);
  assert.ok(!/hourly_rate/i.test(m.replace(/--.*$/gm, "")), "no money in the SQL");
  assert.ok(!m.includes(EM_DASH));
});

test("no B32 file multiplies hours by a rate or shows a rupee amount", () => {
  for (const f of [
    "lib/hours/parse.ts",
    "lib/hours/month.ts",
    "lib/hours/load.ts",
    "components/settings/hours-target-panel.tsx",
  ]) {
    const code = src(f).replace(/\/\/.*$/gm, "");
    assert.ok(!/hourly_rate|formatINR|₹|\bRs\b|\brate\b/i.test(code), `${f}: no rate or rupee`);
    assert.ok(!src(f).includes(EM_DASH), `${f}: no em dash`);
  }
  // The files B32 touched must not combine hours with the rate column.
  for (const f of ["lib/assistant/mcp-api.ts", "app/(app)/page.tsx", "lib/brief/compose.ts"]) {
    assert.ok(!/hours[^\n]*hourly_rate|hourly_rate[^\n]*hours/i.test(src(f)), `${f}: hours never meet the rate`);
  }
});

test("last week counts unlogged tasks and the brief line says so", () => {
  const wed = new Date(Date.UTC(2026, 9, 7, 6)).toISOString();
  const w = lastWeekHours(
    [task({ id: "1", completed_at: wed, hours_spent: 4 }), task({ id: "2", completed_at: wed, hours_spent: null }), task({ id: "3", completed_at: wed, hours_spent: null })],
    85,
    MON_12_OCT
  );
  assert.equal(w.missing, 2);
  assert.equal(hoursBriefLine(w, MON_12_OCT), "Billable hours last week: 4 (target pace 20, 2 tasks unlogged).");
  assert.equal(hoursBriefLine({ ...w, missing: 1 }, MON_12_OCT), "Billable hours last week: 4 (target pace 20, 1 task unlogged).");
  assert.equal(hoursBriefLine({ ...w, missing: 0 }, MON_12_OCT), "Billable hours last week: 4 (target pace 20).");
});

test("hours_spent as a string is parsed, a bad string is refused, null clears", async () => {
  resetDb();
  const t = addTask({ hours_spent: 2 });
  await executeToolCall("update_task", { task_id: t.id, hours_spent: "1.5" });
  assert.equal(t.hours_spent, 1.5);
  await assert.rejects(() => executeToolCall("update_task", { task_id: t.id, hours_spent: "abc" }), /Enter hours/);
  assert.equal(t.hours_spent, 1.5, "unchanged after a refusal");
  await executeToolCall("update_task", { task_id: t.id, hours_spent: null });
  assert.equal(t.hours_spent, null, "null clears");
});
