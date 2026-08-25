// Offline proof of the Eisenhower triage that drives Home and the Tasks
// overview: urgent+important first, important (including the starved
// no-deadline set) second, urgent-only third; plus the Wednesday weekend
// guard. Run: npm run test:triage

import test from "node:test";
import assert from "node:assert/strict";
import {
  triage,
  isUrgent,
  needsDeadline,
  weekendGuard,
  type TriageTask,
} from "../lib/tasks/triage.ts";

const NOW = Date.parse("2026-08-25T06:00:00Z"); // 11:30 am IST Tuesday

function t(
  id: string,
  priority: TriageTask["priority"],
  due: string | null
): TriageTask {
  return { id, title: id, priority, due_ts: due, status: "todo" };
}

test("bands follow urgent+important, important, urgent, later", () => {
  const tasks = [
    t("later", "low", "2026-09-20T04:00:00Z"),
    t("urgent_only", "medium", "2026-08-25T10:00:00Z"),
    t("do_first", "high", "2026-08-25T10:00:00Z"),
    t("starved", "high", null),
    t("important_dated", "high", "2026-09-05T04:00:00Z"),
  ];
  const r = triage(tasks, NOW);
  assert.deepEqual(r.do_first.map((x) => x.id), ["do_first"]);
  // Dated important sorts before the undated starved one inside the band.
  assert.deepEqual(r.important.map((x) => x.id), ["important_dated", "starved"]);
  assert.deepEqual(r.urgent.map((x) => x.id), ["urgent_only"]);
  assert.deepEqual(r.later.map((x) => x.id), ["later"]);
});

test("overdue counts as urgent; a due date 3 days out does not", () => {
  assert.ok(isUrgent(t("a", "low", "2026-08-20T04:00:00Z"), NOW));
  assert.ok(isUrgent(t("b", "low", "2026-08-26T10:00:00Z"), NOW));
  assert.ok(!isUrgent(t("c", "low", "2026-08-28T10:00:00Z"), NOW));
});

test("needs_deadline flags only high-priority undated tasks", () => {
  assert.ok(needsDeadline(t("a", "high", null)));
  assert.ok(!needsDeadline(t("b", "medium", null)));
  assert.ok(!needsDeadline(t("c", "high", "2026-09-01T04:00:00Z")));
});

test("weekend guard fires Wednesday to Friday for Sat-Mon due dates", () => {
  // 2026-08-29 Sat, 30 Sun, 31 Mon (IST). Due 9:30 am IST Monday.
  const monday = t("mon", "medium", "2026-08-31T04:00:00Z");
  const keys: [string, string, string] = ["2026-08-29", "2026-08-30", "2026-08-31"];
  assert.equal(weekendGuard([monday], 3, keys).length, 1); // Wednesday
  assert.equal(weekendGuard([monday], 5, keys).length, 1); // Friday
  assert.equal(weekendGuard([monday], 2, keys).length, 0); // Tuesday: quiet
  assert.equal(weekendGuard([monday], 6, keys).length, 0); // Saturday: too late
  const tuesday = t("tue", "medium", "2026-09-01T04:00:00Z");
  assert.equal(weekendGuard([tuesday], 4, keys).length, 0); // not a weekend date
});
