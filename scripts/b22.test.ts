// B22 offline proof: connector completeness. Run: npm run test:b22
//
// The AI workforce runs Tapas's day through the MCP connector, and a 28
// September 2026 audit found app capabilities it could not reach: the month
// pack, expense lines, the fuller task fields, projects, the brief and the
// scan digest, work streams, trip upkeep, search and the two review reports,
// and, approved by Tapas the same day, the text of one named mail attachment
// on request. Synthetic data only: no database, no mailbox, no network.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { deflateRawSync } from "node:zlib";
import {
  buildMonthPack,
  monthPackFromRows,
  monthPackText,
  toMonthExpense,
  toMonthTrip,
  type ExpenseDbRow,
  type TripDbRow,
} from "../lib/trips/month.ts";
import { expenseLine, expensePatch, expenseUndo, type ExpenseRow } from "../lib/trips/expense-edit.ts";
import { editLeg, removeLeg } from "../lib/trips/legs.ts";
import { resolveTaskExtras, taskUndoPatch, TASK_UNDO_COLUMNS } from "../lib/tasks/tool-fields.ts";
import { checkStreamEdit, SCAN_HINT_MAX } from "../lib/tasks/stream.ts";
import { taskContextLines, type ContextTask } from "../lib/assistant/context-tasks.ts";
import { searchRows, searchKinds, EXCERPT_CHARS, SEARCH_MAX, type SearchRow } from "../lib/assistant/search.ts";
import {
  ATTACHMENT_MAX_BYTES,
  ATTACHMENT_TEXT_CAP,
  attachmentAuditRow,
  readMailAttachment,
  readMailAttachmentRecorded,
  type AttachmentAuditRow,
} from "../lib/assistant/attachment.ts";
import { pdfText } from "../lib/assistant/pdf-text.ts";
import { docxText } from "../lib/assistant/docx-text.ts";
import type { MailAccount, MailRequest } from "../lib/assistant/mailbox.ts";
import { keepBrief, lastBrief, briefCutoff, type BriefRow, type BriefStore } from "../lib/brief/store.ts";
import { scanRuns, clampScanDays } from "../lib/assistant/scan-runs.ts";
import { matchesNeverExtract, BRANCH_COORDINATION } from "../lib/assistant/scan-filters.ts";
import { SCAN_SYSTEM } from "../lib/assistant/prompt.ts";
import {
  CAB_TOOL,
  MCP_READ_TOOLS,
  READ_TOOL_DISCLOSURES,
  SCAN_TOOL,
  TICKET_TOOL,
  TOOLS,
  TOOL_DISCLOSURES,
  TOOL_TARGETS,
  mcpWriteTools,
  toolByName,
} from "../lib/assistant/tools.ts";
import { formatDateIST } from "../lib/datetime.ts";

const src = (rel: string) => readFileSync(new URL("../" + rel, import.meta.url), "utf8");

// ---------------------------------------------------------------------------
// 1. The month pack
// ---------------------------------------------------------------------------

const TRIP_ROWS: TripDbRow[] = [
  {
    id: "t-rajkot",
    title: "AICA session, Rajkot branch",
    start_date: "2026-08-04",
    end_date: "2026-08-05",
    cities: ["Rajkot"],
    bills_to: "icai_monthly",
    legs: [
      { from: "Ahmedabad", to: "Rajkot", date: "2026-08-04", mode: "vande_bharat", cost: 800 },
      { from: "Rajkot", to: "Ahmedabad", date: "2026-08-05", mode: "vande_bharat", cost: 800 },
    ],
  },
  {
    id: "t-dubai",
    title: "Chapter session, Dubai",
    start_date: "2026-08-20",
    end_date: "2026-08-22",
    cities: ["Dubai"],
    bills_to: "chapter_aed",
    legs: [],
  },
  {
    id: "t-sept",
    title: "AICA session, Surat",
    start_date: "2026-09-02",
    end_date: "2026-09-02",
    cities: ["Surat"],
    bills_to: "icai_monthly",
    legs: [],
  },
];
const EXPENSE_ROWS: ExpenseDbRow[] = [
  { id: "e1", trip_id: "t-rajkot", category: "transport", amount: "800", date: "2026-08-04", billable: true, receipt_ref: "email:gmail:icai:m1" },
  { id: "e2", trip_id: "t-rajkot", category: "hotel", amount: 2500, date: "2026-08-04", billable: true, receipt_ref: null },
  { id: "e3", trip_id: "t-rajkot", category: "per_diem", amount: 500, date: "2026-08-05", billable: false, receipt_ref: null },
  { id: "e4", trip_id: "t-dubai", category: "hotel", amount: 9000, date: "2026-08-21", billable: true, receipt_ref: null },
];

test("get_month_pack returns the same gaps, lines and text as the page's builder", () => {
  // What the Month pack screen does: map rows, then build.
  const page = buildMonthPack(TRIP_ROWS.map(toMonthTrip), EXPENSE_ROWS.map(toMonthExpense), "2026-08");
  const tool = monthPackFromRows(TRIP_ROWS, EXPENSE_ROWS, "2026-08");
  assert.deepEqual(tool.pack, page);
  assert.equal(tool.text, monthPackText(page));
  // The gaps: only the Rajkot hotel line. The Dubai hotel is excluded with its
  // trip, and the per diem is not billable.
  assert.deepEqual(tool.pack.gaps.map((g) => g.id), ["e2"]);
  assert.deepEqual(tool.pack.excluded.map((x) => x.trip_id), ["t-dubai"]);
  assert.equal(tool.pack.legs.length, 2);
  // The pack carries no total by design (M6d); the billable figures the two
  // agree on are the lines themselves.
  const billable = (p: typeof page) =>
    p.expense_groups.flatMap((g) => g.expenses).filter((e) => e.billable).map((e) => e.amount);
  assert.deepEqual(billable(tool.pack), billable(page));
  assert.deepEqual(billable(tool.pack), [800, 2500]);
  assert.doesNotMatch(tool.text, /^total|grand total|total:/im, "no total he could mistake for a claim");
});

test("the connector and the page map rows through the same functions", () => {
  const api = src("lib/assistant/mcp-api.ts");
  const handler = api.slice(api.indexOf('if (name === "lifeos_get_month_pack")'), api.indexOf('if (name === "lifeos_list_trip_expenses")'));
  assert.match(handler, /monthPackFromRows\(/);
  const page = src("app/(app)/trips/month/page.tsx");
  assert.match(page, /\.map\(toMonthTrip\)/);
  assert.match(page, /\.map\(toMonthExpense\)/);
});

// ---------------------------------------------------------------------------
// 2. Expense lines
// ---------------------------------------------------------------------------

test("list_trip_expenses lists each line with id, date, category, amount, billable and receipt_ref", () => {
  const lines = EXPENSE_ROWS.filter((e) => e.trip_id === "t-rajkot").map(expenseLine);
  assert.equal(lines.length, 3);
  assert.deepEqual(lines[0], {
    id: "e1",
    date: "2026-08-04",
    category: "transport",
    amount: 800,
    billable: true,
    receipt_ref: "email:gmail:icai:m1",
    receipt_missing: false,
  });
  assert.equal(lines[1].receipt_missing, true, "a billable line with no reference is flagged");
  assert.equal(lines[2].receipt_missing, false, "his own cost is never a gap");
});

test("update_trip_expense sets receipt_ref, and its undo restores the old value", () => {
  const row: ExpenseRow = { category: "hotel", amount: 2500, date: "2026-08-04", billable: true, receipt_ref: null };
  const p = expensePatch({ expense_id: "e2", receipt_ref: "physical file, August folder" });
  assert.ok(p.ok);
  const undo = expenseUndo(row, p.value);
  const after = { ...row, ...p.value };
  assert.equal(after.receipt_ref, "physical file, August folder");
  assert.deepEqual(Object.keys(undo), ["receipt_ref"], "undo keeps only what was changed");
  assert.deepEqual({ ...after, ...undo }, row, "undo restores the line exactly");
  // Checked, not trusted.
  assert.equal(expensePatch({ category: "bill" }).ok, false);
  assert.equal(expensePatch({ date: "4 Aug" }).ok, false);
  assert.equal(expensePatch({ amount: -1 }).ok, false);
  assert.equal(expensePatch({}).ok, false, "nothing to change is refused");
});

test("the expense tool reuses the trip screen's write, keeps the old values, and has no delete twin", () => {
  const exec = src("lib/assistant/execute.ts");
  const perf = exec.slice(exec.indexOf("async update_trip_expense("), exec.indexOf("async update_project("));
  assert.match(perf, /updateTripExpense\(supabase, userId, expenseId, p\.value\)/);
  assert.match(perf, /expenseUndo\(/);
  assert.match(src("app/(app)/trips/actions.ts"), /updateTripExpense\(/, "the same write the drawer uses");
  const names = TOOLS.map((t) => t.name);
  for (const forbidden of ["delete_trip", "delete_trip_expense", "delete_expense", "delete_project"]) {
    assert.ok(!names.includes(forbidden), `${forbidden} must not exist`);
  }
});

// ---------------------------------------------------------------------------
// 3. Fuller tasks
// ---------------------------------------------------------------------------

const PROJECTS = [{ id: "p-gst", name: "GST annual returns" }];

test("update_task with billable true sets it, and undo clears it", () => {
  const prev = { title: "Draft reply", is_billable: false, project_id: null, recurring_rule: null, status: "todo" };
  const r = resolveTaskExtras({ task_id: "t1", billable: true }, PROJECTS);
  assert.ok(r.ok);
  assert.deepEqual(r.patch, { is_billable: true });
  const after = { ...prev, ...r.patch };
  assert.equal(after.is_billable, true);
  const restore = taskUndoPatch(prev);
  assert.equal(restore.is_billable, false, "undo clears it again");
  assert.equal(restore.project_id, null);
  assert.equal(restore.recurring_rule, null);
  // A snapshot written before B22 has no such keys and leaves them alone.
  const old = taskUndoPatch({ title: "Old" });
  assert.ok(!("is_billable" in old) && !("project_id" in old) && !("recurring_rule" in old));
  // The snapshot the performer takes carries all three.
  for (const col of ["is_billable", "project_id", "recurring_rule"]) {
    assert.ok(TASK_UNDO_COLUMNS.includes(col), col);
  }
});

test("an unknown project_id is refused", () => {
  const r = resolveTaskExtras({ project_id: "p-nope" }, PROJECTS);
  assert.equal(r.ok, false);
  assert.match(!r.ok ? r.message : "", /no project with id p-nope/);
  const ok = resolveTaskExtras({ project_id: "p-gst" }, PROJECTS);
  assert.ok(ok.ok && ok.patch.project_id === "p-gst");
  const cleared = resolveTaskExtras({ project_id: "" }, PROJECTS);
  assert.ok(cleared.ok && cleared.patch.project_id === null, "an empty id clears the project");
});

test("an invalid recurring_rule is refused, a real one is kept", () => {
  for (const bad of ["fortnightly", "monthly:0", "weekly:x", "every tuesday"]) {
    const r = resolveTaskExtras({ recurring_rule: bad }, []);
    assert.equal(r.ok, false, bad);
  }
  const r = resolveTaskExtras({ recurring_rule: "Weekly:2" }, []);
  assert.ok(r.ok && r.patch.recurring_rule === "weekly:2");
});

test("create_task and update_task carry project_id and recurring_rule, one type each", () => {
  for (const name of ["create_task", "update_task"]) {
    const props = (toolByName(name)!.input_schema as unknown as { properties: Record<string, { type: unknown }> }).properties;
    assert.equal(props.project_id.type, "string", name);
    assert.equal(props.recurring_rule.type, "string", name);
    assert.equal(props.billable.type, "boolean", name);
  }
  const exec = src("lib/assistant/execute.ts");
  for (const perf of ["async create_task(", "async update_task("]) {
    const body = exec.slice(exec.indexOf(perf), exec.indexOf("\n  },", exec.indexOf(perf)));
    assert.match(body, /resolveTaskExtras\(input, await projectsIfNamed\(/, perf);
  }
});

test("list_tasks returns created_at and billable, and its search reads the note too", () => {
  const api = src("lib/assistant/mcp-api.ts");
  const handler = api.slice(api.indexOf('if (name === "lifeos_list_tasks")'), api.indexOf('if (name === "lifeos_list_events")'));
  for (const col of ["is_billable", "lapses_on", "created_at", "completed_at", "recurring_rule", "reminder_mode", "projects(name)"]) {
    assert.ok(handler.includes(col), col);
  }
  for (const field of ["billable: t.is_billable", "created_at: t.created_at", "completed_at: t.completed_at", "project:", "recurring_rule: t.recurring_rule", "reminder_mode: t.reminder_mode", "lapses_on: t.lapses_on"]) {
    assert.ok(handler.includes(field), field);
  }
  assert.ok(handler.includes("title.ilike.%${safe}%,notes.ilike.%${safe}%"), "title or note");
});

test("get_context prints the stream and created date on a scanned row, still fenced", () => {
  const base: Omit<ContextTask, "id" | "title" | "source" | "stream"> = {
    status: "todo",
    priority: "medium",
    priority_source: "assistant",
    priority_reason: null,
    due_ts: "2026-10-03T04:00:00Z",
    not_before: null,
    created_at: "2026-09-26T21:40:00Z",
  };
  const lines = taskContextLines(
    [
      { ...base, id: "a", title: "Reply to Clientco on the notice", source: "email", stream: "Tax Strategia" },
      { ...base, id: "b", title: "Renew passport", source: "manual", stream: "Personal" },
    ],
    "2026-09-28"
  ).join("\n");
  const created = formatDateIST("2026-09-26T21:40:00Z");
  const fence = lines.slice(lines.indexOf("```"));
  assert.match(fence, /a \| Reply to Clientco on the notice \| Tax Strategia \|/);
  assert.ok(fence.includes(`created ${created}`), "the scanned row names its created date inside the fence");
  assert.ok(lines.includes(`b | Renew passport | Personal |`));
  assert.ok(lines.slice(0, lines.indexOf("```")).includes(`created ${created}`), "and the trusted row too");
  assert.ok(!lines.slice(0, lines.indexOf("```")).includes("Clientco"), "a mail row never leaves the fence");
  // The cap stays on the query.
  assert.match(src("lib/assistant/context.ts"), /\.limit\(30\)/);
});

// ---------------------------------------------------------------------------
// 4. Projects and work streams
// ---------------------------------------------------------------------------

test("update_project is undoable, resolves its target and has a single-typed status", () => {
  const t = toolByName("update_project")!;
  assert.equal(t.bucket, "autonomous");
  assert.deepEqual(TOOL_TARGETS.update_project, { arg: "project_id", label: "project", table: "projects" });
  const exec = src("lib/assistant/execute.ts");
  assert.ok(exec.includes('case "update_project":'));
  assert.match(exec.slice(exec.indexOf("const UNDOABLE")), /"update_project"/);
});

test("update_work_stream refuses a hint over 200 characters, and its undo restores the old hint", () => {
  assert.equal(SCAN_HINT_MAX, 200);
  const long = checkStreamEdit(undefined, "x".repeat(201));
  assert.equal(long.ok, false);
  assert.match(!long.ok ? long.message : "", /200 characters/);
  const ok = checkStreamEdit(undefined, "  GST work for clients:\n registrations, returns.  ");
  assert.ok(ok.ok);
  assert.deepEqual(ok.patch, { scan_hint: "GST work for clients: registrations, returns." });
  assert.equal(checkStreamEdit(-5, undefined).ok, false);
  // The undo record keeps the old value of exactly what changed, and the undo
  // writes it back as it was.
  const stream = { hourly_rate: 3500, scan_hint: "Old hint" };
  const prev: Record<string, unknown> = {};
  if ("hourly_rate" in ok.patch) prev.hourly_rate = stream.hourly_rate;
  if ("scan_hint" in ok.patch) prev.scan_hint = stream.scan_hint;
  const after = { ...stream, ...ok.patch };
  assert.deepEqual({ ...after, ...prev }, stream);
  const exec = src("lib/assistant/execute.ts");
  const perf = exec.slice(exec.indexOf("async update_work_stream("), exec.indexOf("async add_trip_checklist("));
  assert.match(perf, /checkStreamEdit\(/);
  assert.match(perf, /prev\.scan_hint = row\.scan_hint/);
  const undoCase = exec.slice(exec.indexOf('case "update_work_stream":'), exec.indexOf('case "add_trip_checklist":'));
  assert.match(undoCase, /\.update\(prev\)/);
  // Settings runs the same check.
  assert.match(src("app/(app)/settings/actions.ts"), /checkStreamEdit\(rate, scanHint\)/);
});

// ---------------------------------------------------------------------------
// 5. Trip upkeep: legs
// ---------------------------------------------------------------------------

// Raw as it might sit in the jsonb column: out of date order, with a ref on
// one leg and a key parseLegs would not keep.
const RAW_LEGS = [
  { from: "Rajkot", to: "Ahmedabad", date: "2026-10-06", mode: "vande_bharat", cost: null, ref: "PNR1" },
  { from: "Ahmedabad", to: "Rajkot", date: "2026-10-05", mode: "tejas", cost: 650, extra: "kept" },
];

test("update_trip_leg changes one leg, and undo restores the legs byte for byte", () => {
  const before = JSON.stringify(RAW_LEGS);
  const r = editLeg(RAW_LEGS, 0, { mode: "vande_bharat", ref: "PNR0" });
  assert.ok(r.ok);
  assert.equal(r.legs[0].from, "Ahmedabad", "index 0 is the first leg by date, as lifeos_list_trips lists them");
  assert.equal(r.legs[0].mode, "vande_bharat");
  assert.equal(r.legs[0].ref, "PNR0");
  assert.equal(r.legs[1].ref, "PNR1", "the other leg is untouched");
  // The column now holds the edit; undo writes back the raw value it read.
  let column: unknown = r.legs;
  const undo = { trip_id: "t", raw_legs: JSON.parse(before) };
  column = undo.raw_legs;
  assert.equal(JSON.stringify(column), before);
  assert.equal(editLeg(RAW_LEGS, 2, {}).ok, false, "an index past the end is refused");
  assert.equal(editLeg(RAW_LEGS, 0, { mode: "bus" }).ok, false);
});

test("remove_trip_leg removes one leg, and undo restores the legs byte for byte", () => {
  const before = JSON.stringify(RAW_LEGS);
  const r = removeLeg(RAW_LEGS, 1);
  assert.ok(r.ok);
  assert.equal(r.legs.length, 1);
  assert.equal(r.leg!.from, "Rajkot");
  const column: unknown = JSON.parse(before);
  assert.equal(JSON.stringify(column), before);
  // The executor keeps the raw column on the row and writes it straight back.
  const exec = src("lib/assistant/execute.ts");
  for (const perf of ["async update_trip_leg(", "async remove_trip_leg("]) {
    const body = exec.slice(exec.indexOf(perf), exec.indexOf("\n  },", exec.indexOf(perf)));
    assert.match(body, /raw_legs: trip\.legs/, perf);
  }
  const undoCase = exec.slice(exec.indexOf('case "update_trip_leg":'), exec.indexOf("default:", exec.indexOf('case "update_trip_leg":')));
  assert.match(undoCase, /legs: \(undo\.raw_legs \?\? \[\]\)/);
  assert.doesNotMatch(undoCase, /parseLegs/, "undo never re-parses the legs");
});

test("trip upkeep tools resolve the trip first, are undoable, and add no delete", () => {
  for (const name of ["add_trip_checklist", "sync_trip_hotel_step", "update_trip_leg", "remove_trip_leg"]) {
    assert.deepEqual(TOOL_TARGETS[name], { arg: "trip_id", label: "trip", table: "trips" }, name);
    assert.match(src("lib/assistant/execute.ts").slice(src("lib/assistant/execute.ts").indexOf("const UNDOABLE")), new RegExp(`"${name}"`));
  }
  const props = (toolByName("update_trip")!.input_schema as unknown as { properties: Record<string, { type: unknown }> }).properties;
  assert.equal(props.cities.type, "array");
  // The checklist goes through the one seeding path, which never writes a
  // step the trip already carries (the B16 rule).
  const write = src("lib/trips/write.ts");
  const add = write.slice(write.indexOf("export async function addTripChecklist("), write.indexOf("export interface HotelSyncChanges"));
  assert.match(add, /seedTripChecklist\(/);
  assert.match(write, /const steps = wanted\.filter\(\(s\) => !have\.has/);
  // And the trip screen's buttons run the same functions.
  const actions = src("app/(app)/trips/actions.ts");
  assert.match(actions, /addTripChecklist\(supabase, user\.id, tripId\)/);
  assert.match(actions, /syncTripHotelStep\(supabase, user\.id, tripId\)/);
});

// ---------------------------------------------------------------------------
// 6. Search and reports
// ---------------------------------------------------------------------------

test("search finds a task by a word that appears only in its note", () => {
  const rows: SearchRow[] = [
    { kind: "tasks", id: "t1", title: "Reply to the department", text: "Mention the Kalupur branch reconciliation in para 3", untrusted: false },
    { kind: "tasks", id: "t2", title: "Kalupur visit", text: "", untrusted: false },
    { kind: "notes", id: "n1", title: "Meeting notes", text: "Nothing relevant\nreference", untrusted: false },
    { kind: "tasks", id: "t3", title: "Notice from Clientco", text: "Reconciliation asked by the officer", untrusted: true },
  ];
  const r = searchRows(rows, "reconciliation");
  assert.deepEqual(r.hits.map((h) => h.id), ["t1", "t3"]);
  assert.ok(r.hits[0].excerpt.toLowerCase().includes("reconciliation"));
  assert.ok(r.hits[0].excerpt.length <= EXCERPT_CHARS + 6);
  // Email-sourced text goes out fenced and flagged.
  assert.equal(r.hits[1].untrusted, true);
  assert.match(r.hits[1].excerpt, /```/);
  // Every word must appear; tags count.
  assert.deepEqual(searchRows(rows, "kalupur reconciliation").hits.map((h) => h.id), ["t1"]);
  assert.deepEqual(searchRows(rows, "reference").hits.map((h) => h.id), ["n1"]);
  // At most 25.
  const many = Array.from({ length: 40 }, (_, i) => ({ kind: "notes" as const, id: `n${i}`, title: "GST", text: "", untrusted: false }));
  const capped = searchRows(many, "gst");
  assert.equal(capped.hits.length, SEARCH_MAX);
  assert.equal(capped.total, 40);
  assert.deepEqual(searchKinds(["people", "bogus"]), ["people"]);
  assert.deepEqual(searchKinds(undefined), ["tasks", "notes", "people", "trips"]);
});

test("the two reports are read only and share the scripts' logic", () => {
  const api = src("lib/assistant/mcp-api.ts");
  const handler = api.slice(api.indexOf('if (name === "lifeos_report_lapsed_tasks")'), api.indexOf('if (name === "lifeos_list_tasks")'));
  assert.match(handler, /buildLapsedReport\(/);
  assert.match(handler, /buildReport\(/);
  assert.doesNotMatch(handler, /\.(insert|update|upsert|delete|rpc)\(/);
  assert.match(src("scripts/report-lapsed-tasks.ts"), /from "\.\.\/lib\/tasks\/reports\.ts"/);
  assert.match(src("scripts/report-premature-tasks.ts"), /from "\.\.\/lib\/tasks\/reports\.ts"/);
});

// ---------------------------------------------------------------------------
// 7. One named attachment, on request only
// ---------------------------------------------------------------------------

function tinyPdf(line: string): Uint8Array {
  const content = `BT /F1 12 Tf 50 750 Td (${line}) Tj ET`;
  const objs = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let out = "%PDF-1.4\n";
  const offs: number[] = [];
  objs.forEach((o, i) => {
    offs.push(out.length);
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = out.length;
  out +=
    `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` +
    offs.map((o) => String(o).padStart(10, "0") + " 00000 n \n").join("");
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return new TextEncoder().encode(out);
}

// A minimal .docx: a zip holding word/document.xml, deflated like Word does.
function tinyDocx(paragraphs: string[]): Uint8Array {
  const xml =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>' +
    paragraphs.map((p) => `<w:p><w:r><w:t xml:space="preserve">${p}</w:t></w:r></w:p>`).join("") +
    "</w:body></w:document>";
  const entries = [
    { name: "[Content_Types].xml", data: Buffer.from("<Types/>") },
    { name: "word/document.xml", data: Buffer.from(xml) },
  ];
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const comp = deflateRawSync(e.data);
    const name = Buffer.from(e.name);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(comp.length, 18);
    local.writeUInt32LE(e.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(comp.length, 20);
    central.writeUInt32LE(e.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, name, comp);
    centrals.push(central, name);
    offset += 30 + name.length + comp.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return new Uint8Array(Buffer.concat([...locals, cd, eocd]));
}

const PDF_BYTES = tinyPdf("Show cause notice under section 73 reply due 15 Oct 2026");
const DOCX_BYTES = tinyDocx(["Draft reply to the notice.", "Para 2: reconciliation &amp; annexure attached."]);
const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const GACC: MailAccount = { id: "acc-ts", slot: "taxstrategia", provider: "google", email: "tapas@taxstrategia.example" };
const GMAIL = "https://gmail.googleapis.com/gmail/v1/users/me";

function attachmentMock() {
  const calls: string[] = [];
  const files: Record<string, Uint8Array> = { a1: PDF_BYTES, a2: DOCX_BYTES, a3: new Uint8Array(10) };
  const request: MailRequest = async (url) => {
    calls.push(url);
    const att = /\/attachments\/(a\d)$/.exec(url);
    if (att) return new Response(JSON.stringify({ data: Buffer.from(files[att[1]]).toString("base64url") }));
    if (url.startsWith(`${GMAIL}/threads/th1?`)) {
      return new Response(
        JSON.stringify({
          messages: [
            {
              id: "m1",
              internalDate: "1759000000000",
              labelIds: ["INBOX"],
              payload: {
                mimeType: "multipart/mixed",
                parts: [
                  { mimeType: "text/plain", body: { data: Buffer.from("Please see attached.").toString("base64url") } },
                  { filename: "Notice.pdf", mimeType: "application/pdf", body: { size: PDF_BYTES.length, attachmentId: "a1" } },
                  { filename: "Reply draft.docx", mimeType: DOCX_MIME, body: { size: DOCX_BYTES.length, attachmentId: "a2" } },
                  { filename: "Scan bundle.pdf", mimeType: "application/pdf", body: { size: ATTACHMENT_MAX_BYTES + 1, attachmentId: "a3" } },
                  { filename: "photo.jpg", mimeType: "image/jpeg", body: { size: 100, attachmentId: "a4" } },
                ],
              },
            },
          ],
        })
      );
    }
    return new Response("{}", { status: 404 });
  };
  return { request, calls };
}

const EXTRACT = { pdf: pdfText, docx: docxText };

test("read_mail_attachment returns fenced text from a PDF and from a DOCX", async () => {
  const m = attachmentMock();
  const pdf = await readMailAttachment(m.request, GACC, { thread_id: "th1", attachment: "notice.pdf" }, EXTRACT);
  assert.equal(pdf.kind, "pdf");
  assert.equal(pdf.attachment_name, "Notice.pdf");
  assert.ok(pdf.text.includes("Show cause notice under section 73 reply due 15 Oct 2026"), pdf.text);
  assert.match(pdf.text, /^[\s\S]*data[\s\S]*```/i, "inside the untrusted fence");
  assert.equal(pdf.untrusted, true);

  const docx = await readMailAttachment(m.request, GACC, { thread_id: "th1", attachment: "Reply draft.docx" }, EXTRACT);
  assert.equal(docx.kind, "docx");
  assert.ok(docx.text.includes("Draft reply to the notice.\nPara 2: reconciliation & annexure attached."), docx.text);
  assert.match(docx.text, /```/);
  assert.ok(docx.chars <= ATTACHMENT_TEXT_CAP);
});

test("read_mail_attachment refuses a file over 5 MB, never downloading it, and an unknown name", async () => {
  const m = attachmentMock();
  await assert.rejects(
    readMailAttachment(m.request, GACC, { thread_id: "th1", attachment: "Scan bundle.pdf" }, EXTRACT),
    /larger than 5 MB/
  );
  assert.ok(!m.calls.some((u) => u.endsWith("/attachments/a3")), "the big file is never fetched");
  await assert.rejects(
    readMailAttachment(m.request, GACC, { thread_id: "th1", attachment: "Invoice.pdf" }, EXTRACT),
    /No attachment called "Invoice\.pdf".*Notice\.pdf/
  );
  await assert.rejects(
    readMailAttachment(m.request, GACC, { thread_id: "th1", attachment: "photo.jpg" }, EXTRACT),
    /not a PDF or a Word/
  );
  await assert.rejects(
    readMailAttachment(m.request, { ...GACC, slot: "icai" }, { thread_id: "th1", attachment: "Notice.pdf" }, EXTRACT),
    /icai mailbox is not open/
  );
  // The real length decides too, when the provider understates the size.
  const big = new Uint8Array(ATTACHMENT_MAX_BYTES + 1);
  const lying: MailRequest = async (url) =>
    /\/attachments\//.test(url)
      ? new Response(JSON.stringify({ data: Buffer.from(big).toString("base64url") }))
      : m.request(url);
  await assert.rejects(
    readMailAttachment(lying, GACC, { thread_id: "th1", attachment: "Notice.pdf" }, EXTRACT),
    /larger than 5 MB/
  );
});

test("read_mail_attachment is never reachable from the scan path", () => {
  const scan = src("lib/assistant/scan.ts");
  assert.doesNotMatch(scan, /attachment\.ts|readMailAttachment|docx-text/);
  assert.doesNotMatch(src("app/api/cron/scan/route.ts"), /attachment|readMailAttachment/i);
  for (const t of [SCAN_TOOL, TICKET_TOOL, CAB_TOOL]) {
    assert.notEqual(t.name, "lifeos_read_mail_attachment");
  }
  // Not a registry tool, so executeToolCall cannot run it; a read tool only.
  assert.equal(toolByName("lifeos_read_mail_attachment"), undefined);
  assert.equal(toolByName("read_mail_attachment"), undefined);
  assert.ok((MCP_READ_TOOLS as readonly string[]).includes("lifeos_read_mail_attachment"));
  // Still five disclosure classes; it rides mail_body, as the ticket reader does.
  assert.deepEqual([...TOOL_DISCLOSURES], ["none", "app_data", "mail_metadata", "mail_body", "persona"]);
  assert.equal(READ_TOOL_DISCLOSURES.lifeos_read_mail_attachment, "mail_body");
  // The scan's content rule is unchanged: the allowlist and nothing else.
  assert.match(src("lib/assistant/mailbox.ts"), /if \(!mayReadMailContent\(mail\.from\)\) return out;/);
});

test("the attachment audit row has account, thread and file name, and no text", async () => {
  const m = attachmentMock();
  const rows: AttachmentAuditRow[] = [];
  const read = await readMailAttachmentRecorded(m.request, GACC, { thread_id: "th1", attachment: "Notice.pdf" }, EXTRACT, {
    userId: "owner",
    insert: async (row) => {
      rows.push(row);
      return { error: null };
    },
  });
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0].meta, { account: "taxstrategia", thread_id: "th1", attachment_name: "Notice.pdf" });
  assert.equal(rows[0].action, "mail_attachment_read");
  assert.ok(!JSON.stringify(rows[0]).includes("Show cause"), "no text in the audit row");
  assert.ok(read.text.includes("Show cause"));
  assert.deepEqual(Object.keys(attachmentAuditRow("u", GACC, read).meta), ["account", "thread_id", "attachment_name"]);
  // A read that cannot be recorded hands nothing over.
  await assert.rejects(
    readMailAttachmentRecorded(m.request, GACC, { thread_id: "th1", attachment: "Notice.pdf" }, EXTRACT, {
      userId: "owner",
      insert: async () => ({ error: { message: "permission denied" } }),
    }),
    /not handed over/
  );
});

// ---------------------------------------------------------------------------
// 8. The brief store and the scan digest
// ---------------------------------------------------------------------------

function memoryStore(): BriefStore & { rows: BriefRow[] } {
  const rows: BriefRow[] = [];
  return {
    rows,
    async upsert(row) {
      const i = rows.findIndex((r) => r.brief_date === row.brief_date);
      if (i >= 0) rows[i] = row;
      else rows.push(row);
    },
    async deleteBefore(date) {
      for (let i = rows.length - 1; i >= 0; i--) if (rows[i].brief_date < date) rows.splice(i, 1);
    },
    async latest(onOrBefore) {
      const sorted = rows
        .filter((r) => !onOrBefore || r.brief_date <= onOrBefore)
        .sort((a, b) => b.brief_date.localeCompare(a.brief_date));
      return sorted[0] ?? null;
    },
  };
}

test("the brief store keeps the text and get_last_brief returns it; 30 days are kept", async () => {
  const store = memoryStore();
  await keepBrief(store, { brief_date: "2026-08-20", subject: "Old", body_text: "old brief" });
  await keepBrief(store, { brief_date: "2026-09-27", subject: "Morning brief, 27 Sept", body_text: "Do first:\n1. File GSTR-3B" });
  await keepBrief(store, { brief_date: "2026-09-28", subject: "Morning brief, 28 Sept", body_text: "Do first:\n1. Reply to the notice" });
  assert.equal((await lastBrief(store, undefined))?.body_text, "Do first:\n1. Reply to the notice");
  assert.equal((await lastBrief(store, "2026-09-27"))?.body_text, "Do first:\n1. File GSTR-3B");
  assert.ok(!store.rows.some((r) => r.brief_date === "2026-08-20"), "older than 30 days is trimmed");
  assert.equal(briefCutoff("2026-09-28"), "2026-08-30");
  await assert.rejects(lastBrief(store, "28 Sept"), /YYYY-MM-DD/);
  // The cron keeps it, and a failure to keep it never stops the send.
  const cron = src("app/api/cron/brief/route.ts");
  assert.match(cron, /keepBrief\(briefStoreFor\(supabase, userId\), \{ brief_date: istDate, subject, body_text: text \}\)/);
  // RLS on the new table, and it is on the anon list.
  const mig = src("supabase/migrations/20260928000100_b22_brief_store.sql");
  assert.match(mig, /enable row level security/);
  assert.match(mig, /using \(user_id = \(select auth\.uid\(\)\)\)/);
  assert.match(src("scripts/rls.test.mjs"), /"briefs"/);
});

test("list_scan_runs reports counts and ids only, from the 3 AM job's rows", () => {
  const cron = { originating_job: "cron_scan" };
  const runs = scanRuns([
    { id: "c1", action: "cron_scan", ts: "2026-09-27T21:30:00Z", meta: { ist_date: "2026-09-28", scanned: 40, created: 3, notes: ["taxstrategia: a title here"] } },
    { id: "s1", action: "mail_scan", ts: "2026-09-27T21:31:00Z", entity_id: "acc", meta: { slot: "taxstrategia", scanned: 25, dropped_by_thread: 2, dropped_by_resend: 1, never_extract: ["boarding pass"], trip_legs_logged: 1, tickets_without_trip: 1, cab_rides_added: 2, rejected: ["a rejected title"], provenance: cron } },
    { id: "s2", action: "mail_scan", ts: "2026-09-28T10:00:00Z", meta: { scanned: 9, cab_rides_added: 5, provenance: { originating_job: null } } },
    { id: "l1", action: "tasks_lapsed", ts: "2026-09-28T01:30:00Z", meta: { ist_date: "2026-09-28", dropped: ["t9", "t10"] } },
  ]);
  assert.equal(runs.length, 1);
  const r = runs[0];
  assert.equal(r.date, "2026-09-28");
  assert.equal(r.tasks_created, 3);
  assert.equal(r.dropped_as_duplicates, 3);
  assert.equal(r.dropped_as_signatures, 1);
  assert.equal(r.ticket_legs_logged, 1);
  assert.equal(r.tickets_without_trip, 1);
  assert.equal(r.cab_receipts_added, 2, "a scan he ran by hand is not the night's");
  assert.deepEqual(r.lapsed_task_ids, ["t9", "t10"]);
  const json = JSON.stringify(runs);
  assert.ok(!json.includes("a title here") && !json.includes("rejected title") && !json.includes("boarding pass"));
  assert.equal(clampScanDays(40), 14);
  assert.equal(clampScanDays(0), 1);
});

// ---------------------------------------------------------------------------
// 9. ICAI branch coordination mail is never a task (approved 28 Sept 2026)
// ---------------------------------------------------------------------------

test("a branch coordination mail for an AICA batch is dropped; ordinary travel work is kept", () => {
  assert.equal(matchesNeverExtract("Coordinate faculty & travel arrangements for AICA batch"), BRANCH_COORDINATION);
  assert.equal(matchesNeverExtract("Send travel plan to ICAI"), null);
  assert.equal(matchesNeverExtract("Coordinate hotel booking for Kolkata trip"), null);
  assert.match(SCAN_SYSTEM, /coordinate faculty or travel arrangements \(bookings\) for an AICA batch is the branch's work, never a task for Tapas/);
});

// ---------------------------------------------------------------------------
// 10. Surfaces and conventions
// ---------------------------------------------------------------------------

test("every B22 tool is on both connectors with the lifeos_ prefix, and in the in-app chat", () => {
  const writes = mcpWriteTools().map((t) => t.name);
  for (const name of ["update_trip_expense", "update_project", "update_work_stream", "add_trip_checklist", "sync_trip_hotel_step", "update_trip_leg", "remove_trip_leg"]) {
    assert.ok(writes.includes(name), name);
    assert.equal(toolByName(name)!.bucket, "autonomous");
  }
  const reads = [
    "lifeos_get_month_pack",
    "lifeos_list_trip_expenses",
    "lifeos_get_last_brief",
    "lifeos_list_scan_runs",
    "lifeos_list_work_streams",
    "lifeos_search",
    "lifeos_report_lapsed_tasks",
    "lifeos_report_premature_tasks",
    "lifeos_read_mail_attachment",
  ];
  const api = src("lib/assistant/mcp-api.ts");
  for (const name of reads) {
    assert.ok((MCP_READ_TOOLS as readonly string[]).includes(name), name);
    assert.equal(api.match(new RegExp(`^  ${name}:`, "gm"))?.length, 2, `${name} needs a schema and a description`);
    assert.ok(api.includes(`if (name === "${name}")`) || name === "lifeos_read_mail_attachment", `${name} has a handler`);
  }
  // B24: the in-app chat is gone, so these reads reach Claude through the
  // connector only, and nothing offers them to an in-app model any more.
  assert.ok(!api.includes("IN_APP_READ_TOOLS"));
  assert.ok(!api.includes("inAppReadTools"));
});

test("the read schemas keep one concrete type per parameter", () => {
  const api = src("lib/assistant/mcp-api.ts");
  const block = api.slice(api.indexOf("lifeos_get_month_pack: {"), api.indexOf("// B18. One concrete type per parameter"));
  assert.doesNotMatch(block, /anyOf|oneOf|type: \[/);
  assert.equal(block.split("additionalProperties: false").length - 1, 9);
});

test("no emojis or em dashes in anything B22 wrote", () => {
  for (const file of [
    "lib/assistant/attachment.ts",
    "lib/assistant/docx-text.ts",
    "lib/assistant/search.ts",
    "lib/assistant/context-tasks.ts",
    "lib/assistant/scan-runs.ts",
    "lib/brief/store.ts",
    "lib/brief/store-db.ts",
    "lib/tasks/tool-fields.ts",
    "lib/tasks/reports.ts",
    "lib/trips/legs.ts",
    "lib/trips/expense-edit.ts",
    "supabase/migrations/20260928000100_b22_brief_store.sql",
    "scripts/b22.test.ts",
  ]) {
    const text = src(file);
    assert.ok(!text.includes(String.fromCharCode(0x2014)), `${file} has an em dash`);
    assert.ok(!/\p{Extended_Pictographic}/u.test(text), `${file} has an emoji`);
  }
});
