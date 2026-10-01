// B26 offline proof: instructions for agents on each task. Run: npm run test:b26
//
// Tapas writes an instruction on a task; the daytime agent sweeps read it
// through the connector and report back. Only his own signed-in session may
// write one, and that is enforced by a database trigger (proved live in
// rls.test.mjs on the local stack). Everything here is offline: the real
// executor and connector code run against an in-memory database (see
// b26-stubs.ts and b26-loader.mjs). Synthetic data only.

import { register } from "node:module";
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  INSTRUCTION_COLUMNS,
  INSTRUCTION_MAX,
  RESULT_MAX,
  checkReportArgs,
  instructionHash,
  isPendingInstruction,
  pendingOldestFirst,
} from "../lib/tasks/agent-instructions.ts";
import {
  NEEDS_YOU_HREF,
  agentMarker,
  agentStatusLine,
  needsYouCount,
  needsYouLine,
} from "../lib/tasks/agent-display.ts";
import { TASK_UNDO_COLUMNS, taskUndoPatch } from "../lib/tasks/tool-fields.ts";
import {
  CAB_TOOL,
  MCP_READ_TOOLS,
  READ_TOOL_DISCLOSURES,
  SCAN_TOOL,
  TICKET_TOOL,
  TOOLS,
  TOOL_TARGETS,
  mcpWriteTools,
  schemaStats,
  toolByName,
} from "../lib/assistant/tools.ts";
import { db, resetDb, fakeSupabase } from "./b26-stubs.ts";

register("./b26-loader.mjs", import.meta.url);
const { executeToolCall, undoExecutedAction } = await import("../lib/assistant/execute.ts");
const { runReadTool, READ_TOOL_SCHEMAS, READ_TOOL_DESCRIPTIONS } = await import("../lib/assistant/mcp-api.ts");
const { createTask, updateTask } = await import("../lib/tasks/write.ts");

const src = (rel: string) => readFileSync(new URL("../" + rel, import.meta.url), "utf8");
const MIGRATION = src("supabase/migrations/20260929000100_b26_task_agent_instructions.sql");

const SECRET_INSTRUCTION = "Draft the reply to the Rajkot branch about the faculty schedule.";
const SECRET_RESULT = "Drafted the reply and saved it for review, nothing was sent.";

function addTask(over: Record<string, unknown> = {}): Record<string, unknown> {
  const row = {
    id: `t-${db.tasks.length + 1}`,
    user_id: "user-1",
    title: "Reply to the branch",
    notes: null,
    status: "todo",
    source: "manual",
    due_ts: null,
    agent_instructions: null,
    agent_instructions_at: null,
    agent_status: null,
    agent_result: null,
    agent_result_at: null,
    agent_done_hash: null,
    ...over,
  };
  db.tasks.push(row);
  return row;
}

// ---------------------------------------------------------------------------
// 1. Pending is derived, never stored
// ---------------------------------------------------------------------------
test("pending rule: blank, whitespace, done, dropped, answered, edited after a result", () => {
  const base = { status: "todo", agent_instructions: SECRET_INSTRUCTION, agent_done_hash: null };
  assert.equal(isPendingInstruction(base), true);
  assert.equal(isPendingInstruction({ ...base, agent_instructions: null }), false, "no instruction");
  assert.equal(isPendingInstruction({ ...base, agent_instructions: "" }), false, "blank");
  assert.equal(isPendingInstruction({ ...base, agent_instructions: "  \n " }), false, "whitespace only");
  assert.equal(isPendingInstruction({ ...base, status: "done" }), false, "done task");
  assert.equal(isPendingInstruction({ ...base, status: "dropped" }), false, "dropped task");
  const answered = { ...base, agent_done_hash: instructionHash(SECRET_INSTRUCTION) };
  assert.equal(isPendingInstruction(answered), false, "matching done hash");
  assert.equal(
    isPendingInstruction({ ...answered, agent_instructions: SECRET_INSTRUCTION + " Also copy the partner." }),
    true,
    "edited after a result"
  );
});

test("the hash is sha256 hex of the exact stored text", () => {
  assert.match(instructionHash("abc"), /^[0-9a-f]{64}$/);
  assert.notEqual(instructionHash("abc"), instructionHash("abc "));
});

test("the pending list is oldest instruction first and capped at 10", () => {
  const rows = Array.from({ length: 12 }, (_, i) => ({
    id: `r${i}`,
    status: "todo",
    agent_instructions: `do ${i}`,
    agent_done_hash: null,
    agent_instructions_at: `2026-09-${String(29 - i).padStart(2, "0")}T05:00:00Z`,
  }));
  const out = pendingOldestFirst(rows);
  assert.equal(out.length, 10);
  assert.equal(out[0].id, "r11", "the oldest first");
  assert.equal(out[9].id, "r2");
});

test("the arguments of report_agent_result are checked before any row is read", () => {
  assert.equal(checkReportArgs({ status: "maybe", result: "x" }).ok, false);
  assert.equal(checkReportArgs({ status: "done", result: "   " }).ok, false);
  assert.equal(checkReportArgs({ status: "done", result: "x".repeat(RESULT_MAX + 1) }).ok, false);
  assert.equal(checkReportArgs({ status: "needs_you", result: "x".repeat(RESULT_MAX) }).ok, true);
  assert.equal(INSTRUCTION_MAX, 2000);
  assert.equal(RESULT_MAX, 4000);
});

// ---------------------------------------------------------------------------
// 2. What Tapas sees
// ---------------------------------------------------------------------------
test("the drawer status, the row marker and the Home line read in plain words", () => {
  const pending = { agent_instructions: "x", agent_pending: true, agent_status: null };
  assert.equal(agentStatusLine(pending, null), "Waiting for the next sweep");
  assert.equal(agentMarker(pending), "Agent");
  const done = { agent_instructions: "x", agent_pending: false, agent_status: "done" };
  assert.equal(agentStatusLine(done, "29 Sept, 12:40 pm"), "Done 29 Sept, 12:40 pm");
  assert.equal(agentMarker(done), null);
  const needs = { agent_instructions: "x", agent_pending: false, agent_status: "needs_you" };
  assert.equal(agentStatusLine(needs, null), "Needs you");
  assert.equal(agentMarker(needs), "Needs you");
  assert.equal(agentStatusLine({ agent_instructions: null, agent_status: null }, null), null);
  assert.equal(needsYouLine(0), null, "nothing when zero");
  assert.equal(needsYouLine(1), "1 agent result needs you");
  assert.equal(needsYouLine(2), "2 agent results need you");
  assert.equal(needsYouCount([needs, done, pending, needs]), 2);
  assert.equal(NEEDS_YOU_HREF, "/tasks?agent=needs_you");
});

test("the screens are wired: drawer box with a counter, row marker, Home line, page columns", () => {
  const view = src("components/tasks/tasks-view.tsx");
  assert.match(view, /Instructions for agents/);
  assert.match(view, /INSTRUCTION_MAX/);
  assert.match(view, /agentMarker\(task\)/);
  assert.match(view, /agent_instructions: f\.agentInstructions\.trim\(\) \? f\.agentInstructions : null/, "blank maps to null");
  const page = src("app/(app)/tasks/page.tsx");
  for (const col of ["agent_instructions", "agent_status", "agent_result", "agent_result_at", "agent_done_hash"]) {
    assert.ok(page.includes(col), `the Tasks page selects ${col}`);
  }
  assert.match(page, /isPendingInstruction/);
  const home = src("app/(app)/page.tsx");
  assert.match(home, /needsYouLine\(needsYouCount/);
  assert.match(home, /agent_status/);
});

// ---------------------------------------------------------------------------
// 3. report_agent_result and the read tool, against the real executor
// ---------------------------------------------------------------------------
test("a stale hash is refused and the refusal carries the current instruction and hash", async () => {
  resetDb();
  const t = addTask({ agent_instructions: SECRET_INSTRUCTION, agent_instructions_at: "2026-09-29T05:00:00Z" });
  await assert.rejects(
    () => executeToolCall("report_agent_result", { task_id: t.id, instruction_hash: "0".repeat(64), status: "done", result: SECRET_RESULT }),
    (e: Error) => {
      assert.ok(e.message.includes(SECRET_INSTRUCTION), "the current instruction");
      assert.ok(e.message.includes(instructionHash(SECRET_INSTRUCTION)), "and its hash");
      return true;
    }
  );
  assert.equal(t.agent_status, null, "nothing was recorded");
  assert.equal(t.agent_result, null);
});

test("done removes the task from the pending list, and an answered instruction stays answered", async () => {
  resetDb();
  const t = addTask({ agent_instructions: SECRET_INSTRUCTION, agent_instructions_at: "2026-09-29T05:00:00Z" });
  const before = await runReadTool("lifeos_list_agent_instructions", {});
  assert.equal(before.count, 1);
  const item = (before.items as Record<string, unknown>[])[0];
  assert.equal(item.task_id, t.id);
  assert.equal(item.instruction, SECRET_INSTRUCTION);
  assert.equal(item.instruction_hash, instructionHash(SECRET_INSTRUCTION));
  assert.match(String(item.written_by), /Tapas, in the Life OS app/);

  const out = await executeToolCall("report_agent_result", {
    task_id: t.id,
    instruction_hash: item.instruction_hash,
    status: "done",
    result: SECRET_RESULT,
  });
  assert.match(out.reply, /Agent result \(done\)/);
  assert.equal(t.agent_status, "done");
  assert.equal(t.agent_result, SECRET_RESULT);
  assert.equal(t.agent_done_hash, instructionHash(SECRET_INSTRUCTION));
  assert.ok(t.agent_result_at);
  assert.equal((await runReadTool("lifeos_list_agent_instructions", {})).count, 0);
});

test("needs_you shows on the Home line", async () => {
  resetDb();
  const t = addTask({ agent_instructions: SECRET_INSTRUCTION, agent_instructions_at: "2026-09-29T05:00:00Z" });
  await executeToolCall("report_agent_result", {
    task_id: t.id,
    instruction_hash: instructionHash(SECRET_INSTRUCTION),
    status: "needs_you",
    result: "Which mailbox should the reply go from?",
  });
  assert.equal(t.agent_status, "needs_you");
  assert.equal(needsYouLine(needsYouCount(db.tasks as never[])), "1 agent result needs you");
});

test("a result is accepted on a task done in the meantime", async () => {
  resetDb();
  const t = addTask({ status: "done", agent_instructions: SECRET_INSTRUCTION });
  const out = await executeToolCall("report_agent_result", {
    task_id: t.id,
    instruction_hash: instructionHash(SECRET_INSTRUCTION),
    status: "done",
    result: SECRET_RESULT,
  });
  assert.match(out.reply, /recorded/);
  assert.equal(t.agent_status, "done");
});

test("a task with no instruction refuses a result", async () => {
  resetDb();
  const t = addTask();
  await assert.rejects(
    () => executeToolCall("report_agent_result", { task_id: t.id, instruction_hash: "x", status: "done", result: "y" }),
    /has not given agents an instruction/
  );
});

test("undo restores the previous result and re-opens the instruction", async () => {
  resetDb();
  const hash = instructionHash(SECRET_INSTRUCTION);
  const t = addTask({
    agent_instructions: SECRET_INSTRUCTION,
    agent_instructions_at: "2026-09-29T05:00:00Z",
    agent_status: "needs_you",
    agent_result: "Earlier answer.",
    agent_result_at: "2026-09-28T05:00:00Z",
    agent_done_hash: "older-hash",
  });
  const out = await executeToolCall("report_agent_result", {
    task_id: t.id,
    instruction_hash: hash,
    status: "done",
    result: SECRET_RESULT,
  });
  assert.equal(isPendingInstruction({ ...t, status: "todo" } as never), false);
  const undone = await undoExecutedAction(String(out.actionId));
  assert.equal(undone.ok, true);
  assert.equal(t.agent_result, "Earlier answer.");
  assert.equal(t.agent_status, "needs_you");
  assert.equal(t.agent_done_hash, "older-hash");
  assert.equal(isPendingInstruction({ ...t, status: "todo" } as never), true, "the next sweep does it again");
});

test("the read tool keeps the email fence, orders by age and caps at 10", async () => {
  resetDb();
  for (let i = 0; i < 12; i++) {
    addTask({
      id: `q${i}`,
      title: `Task ${i}`,
      agent_instructions: `instruction ${i}`,
      agent_instructions_at: `2026-09-${String(10 + i).padStart(2, "0")}T05:00:00Z`,
      source: i === 0 ? "email" : "manual",
    });
  }
  addTask({ id: "answered", agent_instructions: "old", agent_done_hash: instructionHash("old") });
  addTask({ id: "closed", status: "dropped", agent_instructions: "never mind" });
  const r = await runReadTool("lifeos_list_agent_instructions", {});
  const items = r.items as Record<string, unknown>[];
  assert.equal(r.count, 10);
  assert.equal(items[0].task_id, "q0", "oldest instruction first");
  assert.equal(items[0].untrusted, true, "a scanned-email title and note stay fenced");
  assert.equal(items[1].untrusted, false);
  assert.ok(!items.some((i) => i.task_id === "answered" || i.task_id === "closed"));
});

test("audit rows for both tools carry ids, hashes, statuses and lengths, never the words", async () => {
  resetDb();
  const t = addTask({ agent_instructions: SECRET_INSTRUCTION, agent_instructions_at: "2026-09-29T05:00:00Z" });
  await runReadTool("lifeos_list_agent_instructions", {});
  await executeToolCall("report_agent_result", {
    task_id: t.id,
    instruction_hash: instructionHash(SECRET_INSTRUCTION),
    status: "done",
    result: SECRET_RESULT,
  });
  const readRow = db.audit_log.find((r) => r.action === "agent_instructions_read");
  assert.ok(readRow, "the read is recorded");
  assert.deepEqual((readRow!.meta as Record<string, unknown>).task_ids, [t.id]);
  assert.equal((readRow!.meta as Record<string, unknown>).count, 1);
  const runRow = db.audit_log.find((r) => r.action === "execute_autonomous");
  assert.ok(runRow, "the write is recorded");
  assert.equal((runRow!.meta as Record<string, unknown>).result_chars, SECRET_RESULT.length);
  const everything = JSON.stringify([db.audit_log, db.assistant_actions.map((a) => a.payload)]);
  assert.ok(!everything.includes(SECRET_INSTRUCTION), "no instruction text in audit or the action payload");
  assert.ok(!everything.includes(SECRET_RESULT), "no result text in audit or the action payload");
});

// ---------------------------------------------------------------------------
// 4. Nothing but Tapas writes an instruction
// ---------------------------------------------------------------------------
function paramNames(node: unknown, out: string[] = []): string[] {
  if (!node || typeof node !== "object") return out;
  if (Array.isArray(node)) {
    node.forEach((n) => paramNames(n, out));
    return out;
  }
  const o = node as Record<string, unknown>;
  if (o.properties && typeof o.properties === "object") {
    for (const [k, v] of Object.entries(o.properties as Record<string, unknown>)) {
      out.push(k);
      paramNames(v, out);
    }
  }
  for (const [k, v] of Object.entries(o)) if (k !== "properties") paramNames(v, out);
  return out;
}

test("no tool schema, read or write, names an instruction column (propose_task included)", () => {
  const every = [
    ...TOOLS.map((t) => [t.name, t.input_schema] as const),
    [SCAN_TOOL.name, SCAN_TOOL.input_schema] as const,
    [TICKET_TOOL.name, TICKET_TOOL.input_schema] as const,
    [CAB_TOOL.name, CAB_TOOL.input_schema] as const,
    ...Object.entries(READ_TOOL_SCHEMAS),
  ];
  assert.ok(every.length > 40);
  for (const [name, schema] of every) {
    for (const p of paramNames(schema)) {
      assert.ok(!(INSTRUCTION_COLUMNS as readonly string[]).includes(p), `${name} has a parameter named ${p}`);
      assert.ok(!/agent_instruction/i.test(p), `${name} has a parameter named ${p}`);
    }
  }
  assert.ok(paramNames(SCAN_TOOL.input_schema).length > 5, "the walker really read propose_task");
});

test("the update undo snapshot and patch never carry an instruction column", () => {
  for (const col of INSTRUCTION_COLUMNS) assert.ok(!TASK_UNDO_COLUMNS.includes(col), col);
  const patch = taskUndoPatch({
    title: "x",
    status: "todo",
    priority: "medium",
    agent_instructions: "planted",
    agent_instructions_at: "2026-09-29T05:00:00Z",
  });
  for (const col of INSTRUCTION_COLUMNS) assert.ok(!(col in patch), col);
});

test("the recurring spawn copies no agent column", () => {
  const write = src("lib/tasks/write.ts");
  const spawn = write.slice(write.indexOf("async function spawnNextOccurrence("), write.indexOf("export async function deleteTask("));
  assert.ok(spawn.length > 500);
  assert.doesNotMatch(spawn.replace(/\/\/[^\n]*/g, ""), /agent_/, "no agent column outside a comment");
  assert.match(spawn, /names no agent_\*/, "and the comment says so");
});

test("only his own form (origin app) can put an instruction in a task write", async () => {
  resetDb();
  const input = { title: "New", work_stream_id: "ws1", agent_instructions: SECRET_INSTRUCTION };
  await createTask(fakeSupabase as never, "user-1", input, "assistant");
  assert.equal(db.tasks[0].agent_instructions ?? null, null, "assistant origin drops it");
  await createTask(fakeSupabase as never, "user-1", { ...input, title: "Mine" }, "app");
  assert.equal(db.tasks[1].agent_instructions, SECRET_INSTRUCTION, "his form keeps it");

  const t = addTask({ id: "u1" });
  await updateTask(fakeSupabase as never, "user-1", "u1", { agent_instructions: "planted" }, "assistant");
  assert.equal(t.agent_instructions, null);
  await updateTask(fakeSupabase as never, "user-1", "u1", { agent_instructions: "planted" }, "undo");
  assert.equal(t.agent_instructions, null);
  await updateTask(fakeSupabase as never, "user-1", "u1", { agent_instructions: "  mine  " }, "app");
  assert.equal(t.agent_instructions, "mine", "trimmed");
  await updateTask(fakeSupabase as never, "user-1", "u1", { agent_instructions: "   " }, "app");
  assert.equal(t.agent_instructions, null, "blank maps to null");
  const tooLong = await updateTask(fakeSupabase as never, "user-1", "u1", { agent_instructions: "x".repeat(INSTRUCTION_MAX + 1) }, "app");
  assert.equal(tooLong.ok, false);
});

test("only his own actions file passes the app origin to a task write", () => {
  const actions = src("app/(app)/tasks/actions.ts");
  assert.match(actions, /updateTask\(supabase, user\.id, id, patch, "app"\)/);
  for (const f of ["lib/assistant/execute.ts", "lib/assistant/scan.ts", "lib/assistant/mcp-api.ts"]) {
    assert.doesNotMatch(src(f), /(createTask|updateTask)\([^)]*"app"\)/, f);
  }
});

test("delete_task refuses a task with a pending instruction", async () => {
  resetDb();
  const t = addTask({ agent_instructions: SECRET_INSTRUCTION });
  await assert.rejects(
    () => executeToolCall("delete_task", { task_id: t.id }),
    /Tapas has given agents an instruction on this task/
  );
  assert.equal(db.tasks.length, 1, "the task is still there");
});

test("the delete_task undo re-inserts the snapshot without the instruction columns", async () => {
  resetDb();
  const hash = instructionHash(SECRET_INSTRUCTION);
  const t = addTask({
    id: "keep-me",
    agent_instructions: SECRET_INSTRUCTION,
    agent_instructions_at: "2026-09-29T05:00:00Z",
    agent_done_hash: hash,
    agent_status: "done",
    agent_result: SECRET_RESULT,
  });
  const out = await executeToolCall("delete_task", { task_id: t.id });
  assert.equal(db.tasks.length, 0);
  const undone = await undoExecutedAction(String(out.actionId));
  assert.equal(undone.ok, true);
  assert.equal(db.tasks.length, 1, "the task is back");
  const back = db.tasks[0];
  assert.equal(back.id, "keep-me");
  for (const col of INSTRUCTION_COLUMNS) assert.ok(!(col in back), `${col} was stripped before the re-insert`);
  assert.equal(back.agent_result, SECRET_RESULT, "his answered result is kept");
});

test("the migration guards on role, JWT role and uid and judges change with is distinct from", () => {
  assert.match(MIGRATION, /auth\.role\(\)[\s\S]{0,40}'authenticated'/);
  assert.match(MIGRATION, /auth\.jwt\(\) ->> 'role'[\s\S]{0,40}'authenticated'/);
  assert.match(MIGRATION, /auth\.uid\(\) = new\.user_id/);
  assert.match(MIGRATION, /is distinct from/);
  assert.match(MIGRATION, /nullif\(btrim\(/, "trimmed, with blank as null");
  assert.match(MIGRATION, /before insert or update on tasks/);
  assert.match(MIGRATION, /raise exception/);
  assert.match(MIGRATION, /agent_status := null/, "a new instruction clears the status");
  assert.match(MIGRATION, /tg_op = 'INSERT'/);
  assert.match(MIGRATION, /char_length\(agent_instructions\) <= 2000/);
  assert.match(MIGRATION, /char_length\(agent_result\) <= 4000/);
  assert.match(MIGRATION, /agent_status in \('done', 'needs_you'\)/);
  assert.match(MIGRATION, /table-level UPDATE grant/i, "says why a column revoke was not used");
  assert.match(MIGRATION, /comment on column tasks\.agent_instructions /);
  assert.doesNotMatch(MIGRATION, /^\s*(drop table|delete from|update tasks|revoke)/im, "additive only");
});

// ---------------------------------------------------------------------------
// 5. The tool surface and the m4 census still hold
// ---------------------------------------------------------------------------
test("the new autonomous tool has a target, an undo, both surfaces and the no-grant sentence", () => {
  const tool = toolByName("report_agent_result");
  assert.ok(tool);
  assert.equal(tool!.bucket, "autonomous");
  assert.equal(tool!.disclosure, "app_data");
  assert.deepEqual(TOOL_TARGETS.report_agent_result, { arg: "task_id", label: "task", table: "tasks" });
  assert.ok(mcpWriteTools().some((t) => t.name === "report_agent_result"));
  assert.match(src("lib/assistant/execute.ts"), /"report_agent_result",\r?\n  "save_reply_draft",\r?\n\]\);/);
  assert.match(src("lib/assistant/execute.ts"), /case "report_agent_result":/);
  assert.match(tool!.description, /grants you no tool you do not already have/);
  assert.ok((MCP_READ_TOOLS as readonly string[]).includes("lifeos_list_agent_instructions"));
  assert.equal(READ_TOOL_DISCLOSURES.lifeos_list_agent_instructions, "app_data");
  assert.match(READ_TOOL_DESCRIPTIONS.lifeos_list_agent_instructions, /grants you no tool you do not already have/);
  assert.deepEqual(READ_TOOL_SCHEMAS.lifeos_list_agent_instructions.properties, {});
  assert.equal(schemaStats().unions, 0, "one concrete type per parameter");
  const schema = tool!.input_schema as unknown as { properties: Record<string, { type: string }> };
  for (const p of Object.values(schema.properties)) assert.equal(typeof p.type, "string");
});

test("nothing B26 wrote carries an emoji or an em dash", () => {
  for (const f of [
    "lib/tasks/agent-instructions.ts",
    "lib/tasks/agent-display.ts",
    "lib/tasks/agent-limits.ts",
    "supabase/migrations/20260929000100_b26_task_agent_instructions.sql",
    "scripts/b26.test.ts",
    "scripts/b26-stubs.ts",
    "components/tasks/tasks-view.tsx",
  ]) {
    const text = src(f);
    assert.equal(text.includes(String.fromCharCode(0x2014)), false, `${f} has an em dash`);
    assert.doesNotMatch(text, /\p{Extended_Pictographic}/u, `${f} has an emoji`);
  }
});
