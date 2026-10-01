// B30 offline proof: unbilled work. Run: npm run test:b30
//
// Which finished client work has no invoice against it, the connector tools
// that read and record it, and the guards that stop an agent from hiding
// unbilled work (the database trigger is proved live in rls.test.mjs on the
// local stack). Everything here is offline and synthetic: the real executor and
// connector code run against an in-memory database (b26-stubs.ts, b26-loader.mjs).

import { register } from "node:module";
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  REF_MAX,
  checkAgentBilling,
  effectiveBillable,
  summarise,
  unbilledBriefLine,
  unbilledGroups,
  type UnbilledInput,
} from "../lib/billing/unbilled.ts";
import { composeBrief } from "../lib/brief/compose.ts";
import {
  MCP_READ_TOOLS,
  READ_TOOL_DISCLOSURES,
  TOOLS,
  TOOL_TARGETS,
  schemaStats,
  toolByName,
} from "../lib/assistant/tools.ts";
import { db, resetDb, fakeSupabase, serviceActor } from "./b26-stubs.ts";

register("./b26-loader.mjs", import.meta.url);
const { executeToolCall, undoExecutedAction } = await import("../lib/assistant/execute.ts");
const { runReadTool, READ_TOOL_SCHEMAS } = await import("../lib/assistant/mcp-api.ts");
const { setBillingState } = await import("../lib/billing/write.ts");

const src = (rel: string) => readFileSync(new URL("../" + rel, import.meta.url), "utf8");
const MIGRATION = src("supabase/migrations/20261002000200_b30_unbilled_work.sql");
const EM_DASH = String.fromCharCode(8212);

const DAY = 86400000;
const NOW = Date.UTC(2026, 9, 5, 1, 30); // Monday 5 October 2026, 7 am IST
const ago = (days: number) => new Date(NOW - days * DAY).toISOString();

function row(over: Partial<UnbilledInput> = {}): UnbilledInput {
  return {
    id: "t1",
    title: "Reply on the notice",
    status: "done",
    completed_at: ago(10),
    billable: null,
    billing_state: null,
    billing_ref: null,
    recurring_rule: null,
    trip_id: null,
    stream_name: "Stream A",
    stream_billable: true,
    ...over,
  };
}

// ---------------------------------------------------------------------------
// 1. Effective billable
// ---------------------------------------------------------------------------
test("effective billable: the task's own choice wins, otherwise the stream's", () => {
  assert.equal(effectiveBillable({ billable: null }, true), true, "stream on, task null");
  assert.equal(effectiveBillable({ billable: false }, true), false, "stream on, task false");
  assert.equal(effectiveBillable({ billable: true }, false), true, "stream off, task true");
  assert.equal(effectiveBillable({ billable: null }, false), false, "stream off, task null");
  assert.equal(effectiveBillable({ billable: null, is_billable: true } as never, false), false, "the older tick no longer counts");
});

test("recurring tasks and trip checklist steps are never billable work", () => {
  assert.equal(effectiveBillable({ billable: true, recurring_rule: "monthly:1" }, true), false);
  assert.equal(effectiveBillable({ billable: true, trip_id: "trip-1" }, true), false);
  const out = unbilledGroups(
    [
      row({ id: "r", recurring_rule: "monthly:1", billable: true }),
      row({ id: "s", trip_id: "trip-1", billable: true }),
      row({ id: "ok" }),
    ],
    NOW
  );
  assert.deepEqual(out.flatMap((g) => g.rows.map((r) => r.id)), ["ok"]);
});

// ---------------------------------------------------------------------------
// 2. The unbilled list
// ---------------------------------------------------------------------------
test("the list holds done tasks with no state or an estimate, inside 180 days", () => {
  const rows = [
    row({ id: "null" }),
    row({ id: "est", billing_state: "estimate_drafted", billing_ref: "EST-0042" }),
    row({ id: "inv", billing_state: "invoiced" }),
    row({ id: "nb", billing_state: "not_billable" }),
    row({ id: "open", status: "todo" }),
    row({ id: "old", completed_at: ago(181) }),
    row({ id: "edge", completed_at: ago(179) }),
    row({ id: "nodate", completed_at: null }),
    row({ id: "off", stream_billable: false }),
  ];
  const groups = unbilledGroups(rows, NOW);
  const ids = groups.flatMap((g) => g.rows.map((r) => r.id)).sort();
  assert.deepEqual(ids, ["edge", "est", "null"]);
  const est = groups.flatMap((g) => g.rows).find((r) => r.id === "est");
  assert.equal(est?.billing_ref, "EST-0042");
  assert.equal(est?.billing_state, "estimate_drafted");
});

test("grouped by stream, oldest completion first; rows carry days since and no amounts", () => {
  const rows = [
    row({ id: "b-new", stream_name: "Stream B", completed_at: ago(5) }),
    row({ id: "a-new", stream_name: "Stream A", completed_at: ago(20) }),
    row({ id: "b-old", stream_name: "Stream B", completed_at: ago(90), project_name: "Audit" }),
    row({ id: "a-old", stream_name: "Stream A", completed_at: ago(40) }),
  ];
  const groups = unbilledGroups(rows, NOW);
  assert.deepEqual(groups.map((g) => g.stream), ["Stream B", "Stream A"], "the stream with the oldest work first");
  assert.deepEqual(groups[0].rows.map((r) => r.id), ["b-old", "b-new"]);
  assert.deepEqual(groups[1].rows.map((r) => r.id), ["a-old", "a-new"]);
  assert.equal(groups[0].rows[0].days_since, 90);
  assert.equal(groups[0].rows[0].project, "Audit");
  const keys = Object.keys(groups[0].rows[0]).join(" ");
  assert.ok(!/amount|rate|total|price|fee/i.test(keys), "no money fields on a row");
});

// ---------------------------------------------------------------------------
// 3. The connector guard
// ---------------------------------------------------------------------------
function addTask(over: Record<string, unknown> = {}): Record<string, unknown> {
  const r = {
    id: `t-${db.tasks.length + 1}`,
    user_id: "user-1",
    title: "Reply on the notice",
    status: "done",
    source: "manual",
    completed_at: ago(10),
    billable: null,
    billing_state: null,
    billing_ref: null,
    recurring_rule: null,
    trip_id: null,
    agent_instructions: null,
    work_streams: { name: "Stream A", billable: true },
    projects: null,
    ...over,
  };
  db.tasks.push(r);
  return r;
}

test("checkAgentBilling: invoiced, clearing and a long ref are refused; the two allowed states pass", () => {
  assert.equal(checkAgentBilling({ state: "invoiced" }, null).ok, false);
  assert.equal(checkAgentBilling({ state: "" }, "estimate_drafted").ok, false, "clearing");
  assert.equal(checkAgentBilling({}, "estimate_drafted").ok, false, "no state is a clear");
  assert.equal(checkAgentBilling({ state: "not_billable" }, "invoiced").ok, false, "away from invoiced");
  assert.equal(checkAgentBilling({ state: "estimate_drafted", ref: "x".repeat(REF_MAX + 1) }, null).ok, false);
  assert.equal(checkAgentBilling({ state: "estimate_drafted", ref: "x".repeat(REF_MAX) }, null).ok, true);
  assert.equal(checkAgentBilling({ state: "not_billable" }, "estimate_drafted").ok, true);
});

test("set_billing_state refuses invoiced, clearing, moving off invoiced and a long ref", async () => {
  resetDb();
  const t = addTask();
  await assert.rejects(
    () => executeToolCall("set_billing_state", { task_id: t.id, state: "invoiced" }),
    /Only Tapas marks work invoiced/
  );
  await assert.rejects(
    () => executeToolCall("set_billing_state", { task_id: t.id, state: "none" }),
    /cannot be cleared/
  );
  await assert.rejects(
    () => executeToolCall("set_billing_state", { task_id: t.id, state: "estimate_drafted", ref: "x".repeat(41) }),
    /limit is 40/
  );
  assert.equal(t.billing_state, null, "nothing was written");
  const inv = addTask({ billing_state: "invoiced", billing_ref: "INV-9" });
  await assert.rejects(
    () => executeToolCall("set_billing_state", { task_id: inv.id, state: "not_billable" }),
    /marked this task invoiced/
  );
  assert.equal(inv.billing_state, "invoiced");
});

test("set_billing_state accepts estimate_drafted with a ref, and not_billable", async () => {
  resetDb();
  const t = addTask();
  const out = await executeToolCall("set_billing_state", { task_id: t.id, state: "estimate_drafted", ref: "EST-0042" });
  assert.equal(t.billing_state, "estimate_drafted");
  assert.equal(t.billing_ref, "EST-0042");
  assert.ok(out.actionId, "recorded as an undoable action");
  const auditRow = db.audit_log.find((r) => r.action === "execute_autonomous");
  assert.ok(auditRow, "audited");
  assert.equal((auditRow!.meta as Record<string, unknown>).state, "estimate_drafted");
  await executeToolCall("set_billing_state", { task_id: t.id, state: "not_billable" });
  assert.equal(t.billing_state, "not_billable");
});

test("undo restores the prior billing state and ref", async () => {
  resetDb();
  const t = addTask({ billing_state: "estimate_drafted", billing_ref: "EST-0001" });
  const out = await executeToolCall("set_billing_state", { task_id: t.id, state: "not_billable", ref: "EST-0002" });
  assert.equal(t.billing_state, "not_billable");
  const undone = await undoExecutedAction(String(out.actionId));
  assert.equal(undone.ok, true);
  assert.equal(t.billing_state, "estimate_drafted");
  assert.equal(t.billing_ref, "EST-0001");
});

test("over the connector an undo cannot clear a state; his own session can", async () => {
  resetDb();
  const t = addTask();
  const out = await executeToolCall("set_billing_state", { task_id: t.id, state: "estimate_drafted", ref: "EST-1" });
  const refused = await undoExecutedAction(String(out.actionId), (await serviceActor()) as never);
  assert.equal(refused.ok, false);
  assert.match(refused.message ?? "", /clear a billing state/);
  assert.equal(t.billing_state, "estimate_drafted", "untouched");
  assert.equal(db.assistant_actions[0].status, "executed", "still undoable from the app");
  const ok = await undoExecutedAction(String(out.actionId));
  assert.equal(ok.ok, true);
  assert.equal(t.billing_state, null);
});

test("an agent cannot delete a task Tapas marked invoiced", async () => {
  resetDb();
  const t = addTask({ billing_state: "invoiced" });
  await assert.rejects(() => executeToolCall("delete_task", { task_id: t.id }), /marked this task invoiced/);
  assert.equal(db.tasks.length, 1);
});

test("his own marks are audited with the previous state and undo puts it back", async () => {
  resetDb();
  const t = addTask({ billing_state: "estimate_drafted", billing_ref: "EST-7" });
  const r = await setBillingState(fakeSupabase as never, "user-1", String(t.id), "invoiced", "INV-12");
  assert.equal(r.ok, true);
  assert.equal(t.billing_state, "invoiced");
  assert.equal(t.billing_ref, "INV-12");
  const meta = db.audit_log.find((a) => a.action === "billing_state_set")!.meta as Record<string, unknown>;
  assert.equal(meta.from_state, "estimate_drafted");
  assert.equal(meta.from_ref, "EST-7");
  if (r.ok) await setBillingState(fakeSupabase as never, "user-1", String(t.id), r.prev.state, r.prev.ref);
  assert.equal(t.billing_state, "estimate_drafted");
  assert.equal(t.billing_ref, "EST-7");
  const long = await setBillingState(fakeSupabase as never, "user-1", String(t.id), "invoiced", "y".repeat(41));
  assert.equal(long.ok, false);
});

// ---------------------------------------------------------------------------
// 4. Schemas, the migration and the read tools
// ---------------------------------------------------------------------------
test("the new tools are registered the way the registry demands", () => {
  const tool = toolByName("set_billing_state");
  assert.equal(tool?.bucket, "autonomous");
  assert.equal(tool?.disclosure, "app_data");
  assert.deepEqual(TOOL_TARGETS.set_billing_state, { arg: "task_id", label: "task", table: "tasks" });
  const props = (tool!.input_schema as unknown as { properties: Record<string, Record<string, unknown>> }).properties;
  assert.deepEqual(props.state.enum, ["estimate_drafted", "not_billable"], "invoiced is not a value an agent can send");
  for (const p of Object.values(props)) assert.equal(typeof p.type, "string", "one concrete type per parameter");
  assert.ok((MCP_READ_TOOLS as readonly string[]).includes("lifeos_list_unbilled"));
  assert.equal(READ_TOOL_DISCLOSURES.lifeos_list_unbilled, "app_data");
  const readProps = (READ_TOOL_SCHEMAS.lifeos_list_unbilled as { properties: Record<string, { type: string }> }).properties;
  assert.equal(readProps.work_stream.type, "string");
  assert.equal(schemaStats(TOOLS).unions, 0, "no union-typed parameter anywhere");
});

test("the migration guards invoiced, clearing and moving away from invoiced in the database", () => {
  assert.match(MIGRATION, /guard_task_billing_state/);
  assert.match(MIGRATION, /auth\.uid\(\) = new\.user_id/);
  assert.match(MIGRATION, /old\.billing_state = 'invoiced'/);
  assert.match(MIGRATION, /new\.billing_state = 'invoiced'/);
  assert.match(MIGRATION, /new\.billing_state is null and old\.billing_state is not null/);
  assert.match(MIGRATION, /billing_state in \('estimate_drafted', 'invoiced', 'not_billable'\)/);
  assert.match(MIGRATION, /char_length\(billing_ref\) <= 40/);
  assert.match(MIGRATION, /billable boolean not null default false/);
  assert.ok(!/update\s+work_streams|insert\s+into/i.test(MIGRATION), "no stream is seeded as billable");
  assert.ok(!MIGRATION.includes(EM_DASH), "no em dashes");
});

test("the connector read returns the rows, the instruction and no amounts", async () => {
  resetDb();
  addTask({ id: "u1", agent_instructions: "Draft the estimate and leave it unsent." });
  addTask({ id: "u2", billing_state: "invoiced" });
  addTask({ id: "u3", recurring_rule: "monthly:1" });
  addTask({ id: "u4", work_streams: { name: "Stream B", billable: false } });
  const r = await runReadTool("lifeos_list_unbilled", {});
  const groups = r.groups as { work_stream: string; tasks: Record<string, unknown>[] }[];
  assert.equal(r.count, 1);
  assert.equal(groups[0].tasks[0].task_id, "u1");
  assert.equal(groups[0].tasks[0].instructions_for_agents, "Draft the estimate and leave it unsent.");
  const filtered = await runReadTool("lifeos_list_unbilled", { work_stream: "Stream B" });
  assert.equal(filtered.count, 0);
  assert.ok(!/"(amount|total|price|rate|fee)[a-z_]*"\s*:/i.test(JSON.stringify(r)), "no money fields");
});

test("lifeos_list_tasks reports effective billable, billing state and ref", async () => {
  resetDb();
  addTask({ id: "x1", status: "todo", billing_state: "estimate_drafted", billing_ref: "EST-5", is_billable: false });
  addTask({ id: "x2", status: "todo", billable: false });
  const r = await runReadTool("lifeos_list_tasks", {});
  const items = r.items as Record<string, unknown>[];
  const a = items.find((i) => i.id === "x1")!;
  const b = items.find((i) => i.id === "x2")!;
  assert.equal(a.billable, true, "stream on, task null");
  assert.equal(a.billing_state, "estimate_drafted");
  assert.equal(a.billing_ref, "EST-5");
  assert.equal(b.billable, false, "task override");
});

// ---------------------------------------------------------------------------
// 5. The Monday brief
// ---------------------------------------------------------------------------
const summary = summarise(
  unbilledGroups(
    [
      row({ id: "a", stream_name: "Stream A", completed_at: ago(30) }),
      row({ id: "b", stream_name: "Stream B", completed_at: ago(12), title: "Client-Secret matter" }),
    ],
    NOW
  )
);

function brief(nowMs: number, unbilled: typeof summary | null) {
  return composeBrief({
    nowMs,
    tasks: [],
    events: [],
    pendingApprovalsCount: 0,
    accountsNeedingReconnect: [],
    appBaseUrl: "https://example.test",
    unbilled,
  });
}

test("the brief names unbilled work on a Monday with some, and only then", () => {
  const monday = brief(NOW, summary);
  assert.match(monday.text, /Unbilled work: 2 finished tasks across Stream A, Stream B not invoiced, oldest from 5 Sept(ember)? 2026\./);
  assert.match(monday.text, /https:\/\/example\.test\/unbilled/);
  assert.match(monday.html, /https:\/\/example\.test\/unbilled/);
  const tuesday = brief(NOW + DAY, summary);
  assert.ok(!tuesday.text.includes("Unbilled work"), "not on a Tuesday");
  assert.ok(!brief(NOW, summarise([])).text.includes("Unbilled work"), "nothing when zero");
  assert.ok(!brief(NOW, null).text.includes("Unbilled work"), "nothing when unread");
  assert.equal(unbilledBriefLine(summarise([])), null);
});

test("the brief line names stream names only, never a task title", () => {
  const text = brief(NOW, summary).text;
  assert.ok(!text.includes("Client-Secret"), "no task or client detail");
});

test("no B30 file carries an amount, rate, total or Zoho call", () => {
  for (const f of [
    "lib/billing/unbilled.ts",
    "lib/billing/load.ts",
    "lib/billing/write.ts",
    "components/billing/unbilled-view.tsx",
  ]) {
    const code = src(f).replace(/\/\/.*$/gm, "");
    // A label may say "Zoho number"; what must never appear is money or a call.
    assert.ok(!/formatINR|hourly_rate|\bamount\b|\btotal\b|fetch\(|zoho\.(com|in)/i.test(code), `${f}: no money and no Zoho call`);
    assert.ok(!src(f).includes(EM_DASH), `${f}: no em dash`);
  }
});

test("not_billable without a ref clears an earlier estimate ref", async () => {
  resetDb();
  const t = addTask({ billing_state: "estimate_drafted", billing_ref: "EST-9" });
  await executeToolCall("set_billing_state", { task_id: t.id, state: "not_billable" });
  assert.equal(t.billing_state, "not_billable");
  assert.equal(t.billing_ref, null);
});
