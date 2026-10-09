// Offline proof for M7c (Brain, health, one chat thread). Run: npm run test:m7c.
// Node 22.18+, native TS type-stripping, the same pattern as the m3, m4, m5,
// m6, m6b, m6c, b3, m7a and m7b suites. No network, no database.
//
// What is proven:
//   1. Note search matches the title and the body by one rule, and narrows
//      rather than widens as he types.
//   2. Confirming a person clears the unverified flag, and only his own hand
//      ever writes a confirmed record.
//   3. The recovery-day observation fires the day after a full day on stage
//      and stays quiet every other day, including after a cancelled trip.
//   4. The chat thread trims instead of growing, and what a device hands back
//      is treated as data.
//   5. No tool, and no connector surface, can read the chat transcript.
//   6. The confidential boundary holds on Brain: no note field and no tool
//      parameter invites a document.

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import {
  newestFirst,
  notePreview,
  searchNotes,
  type Note,
} from "../lib/brain/notes.ts";
import {
  RECOVERY_ADVICE,
  recoveryLine,
  recoveryTrips,
  sessionDayKey,
  sessionLabel,
  type RecoveryTrip,
} from "../lib/health/recovery.ts";
import { MCP_READ_TOOLS, TOOLS } from "../lib/assistant/tools.ts";
import { HARD_RULES } from "../lib/assistant/prompt.ts";
import type { CivilDate } from "../lib/datetime.ts";

const src = (rel: string): string =>
  readFileSync(new URL("../" + rel, import.meta.url), "utf8");

const MIGRATION = "supabase/migrations/20260901000700_m7c_brain.sql";

// ---------------------------------------------------------------------------
// 1. Notes: search and the list
// ---------------------------------------------------------------------------

function note(over: Partial<Note> & { id: string }): Note {
  return {
    type: "meeting",
    title: "",
    body_md: null,
    occurred_on: null,
    work_stream_id: null,
    project_id: null,
    people_ids: [],
    task_id: null,
    trip_id: null,
    created_at: "2026-09-01T10:00:00.000Z",
    ...over,
  };
}

const notes: Note[] = [
  note({ id: "a", title: "GST position on works contracts", created_at: "2026-08-01T10:00:00.000Z" }),
  note({
    id: "b",
    title: "Rajkot branch call",
    body_md: "Mehta will confirm the hotel. Level 1 batch moves to October.",
    created_at: "2026-09-01T10:00:00.000Z",
  }),
  note({
    id: "c",
    title: "Idea: quarterly GST digest",
    body_md: "One page a quarter for the Mehta group.",
    created_at: "2026-08-15T10:00:00.000Z",
  }),
];

test("a search matches the title", () => {
  assert.deepEqual(searchNotes(notes, "works").map((n) => n.id), ["a"]);
});

test("a search matches the body, not only the title", () => {
  // "hotel" appears nowhere in a title. A search that only looked at titles
  // would return nothing here and quietly hide the note.
  assert.deepEqual(searchNotes(notes, "hotel").map((n) => n.id), ["b"]);
});

test("search ignores case, in both the title and the body", () => {
  assert.deepEqual(searchNotes(notes, "MEHTA").map((n) => n.id), ["b", "c"]);
  assert.deepEqual(searchNotes(notes, "rajkot").map((n) => n.id), ["b"]);
});

test("a term in the title and a term in the body match the same note", () => {
  // "GST" is a title word on c and "quarter" is a body word on c. Title and
  // body are one haystack, so the pair still finds it.
  assert.deepEqual(searchNotes(notes, "gst quarter").map((n) => n.id), ["c"]);
});

test("a second word narrows the list rather than widening it", () => {
  assert.equal(searchNotes(notes, "gst").length, 2);
  assert.equal(searchNotes(notes, "gst digest").length, 1);
});

test("an empty search is not a filter", () => {
  assert.equal(searchNotes(notes, "").length, 3);
  assert.equal(searchNotes(notes, "   ").length, 3);
});

test("a note with no body never breaks the search", () => {
  assert.doesNotThrow(() => searchNotes(notes, "anything"));
  assert.deepEqual(searchNotes(notes, "zzz"), []);
});

test("the list is newest first, and the source array is left alone", () => {
  const order = newestFirst(notes).map((n) => n.id);
  assert.deepEqual(order, ["b", "c", "a"]);
  assert.deepEqual(notes.map((n) => n.id), ["a", "b", "c"]);
});

test("a preview is one line of plain text, never markup", () => {
  const p = notePreview("## Heading\n\n**bold** and `code`\nsecond line");
  assert.ok(!p.includes("#"));
  assert.ok(!p.includes("*"));
  assert.ok(!p.includes("`"));
  assert.ok(!p.includes("\n"));
  assert.ok(notePreview("x".repeat(400)).length <= 120);
  assert.equal(notePreview(null), "");
});

// ---------------------------------------------------------------------------
// 2. People: confirming clears the flag
// ---------------------------------------------------------------------------

test("confirming a person clears unverified, and clears nothing else", () => {
  const actions = src("app/(app)/brain/actions.ts");
  const fn = actions.slice(actions.indexOf("export async function confirmPersonAction"));
  const body = fn.slice(0, fn.indexOf("\n}"));
  assert.ok(body.includes('.from("people")'));
  assert.ok(body.includes("unverified: false"));
  // It is one flag, not a rewrite: a confirm must not touch the name, the
  // address or anything else he has not looked at.
  assert.ok(!body.includes("name:"));
  assert.ok(!body.includes("emails:"));
});

test("a record he types himself is confirmed; the assistant's is not", () => {
  const brain = src("app/(app)/brain/actions.ts");
  const executor = src("lib/assistant/execute.ts");
  const create = brain.slice(brain.indexOf("export async function createPersonAction"));
  assert.ok(create.slice(0, create.indexOf("\n}")).includes("unverified: false"));

  // The A5 control, unchanged: the assistant's own add_person still lands
  // unverified, which is what makes the flag on the send screen mean anything.
  const addPerson = executor.slice(executor.indexOf("async add_person("));
  assert.ok(addPerson.slice(0, addPerson.indexOf("\n  },")).includes("unverified: true"));
});

test("editing a record confirms it, since reading it is the whole act", () => {
  const brain = src("app/(app)/brain/actions.ts");
  const update = brain.slice(brain.indexOf("export async function updatePersonAction"));
  assert.ok(update.slice(0, update.indexOf("\n}")).includes("unverified: false"));
});

test("confirming refreshes the screen that shows the warning", () => {
  const brain = src("app/(app)/brain/actions.ts");
  const fn = brain.slice(brain.indexOf("export async function confirmPersonAction"));
  // The approval queue highlights unverified recipients. A confirm that did
  // not invalidate that page would leave the old warning on screen.
  assert.ok(fn.slice(0, fn.indexOf("\n}")).includes('revalidatePath("/assistant")'));
});

// ---------------------------------------------------------------------------
// 3. The recovery day (B5)
// ---------------------------------------------------------------------------

function trip(over: Partial<RecoveryTrip> & { id: string }): RecoveryTrip {
  return {
    title: "AICA session",
    status: "done",
    session_label: null,
    session_date: null,
    end_date: null,
    cities: [],
    ...over,
  };
}

const SEP_5: CivilDate = { y: 2026, m: 9, d: 5 };

test("the day after a session is a recovery day", () => {
  const t = trip({
    id: "t1",
    session_label: "L1D2",
    session_date: "2026-09-04",
    end_date: "2026-09-04",
    cities: ["Bangalore"],
  });
  const hit = recoveryTrips([t], SEP_5);
  assert.equal(hit.length, 1);
  const line = recoveryLine(hit);
  assert.ok(line);
  assert.ok(line!.includes("L1D2"));
  assert.ok(line!.includes("Bangalore"));
});

test("the day OF the session is not a recovery day, and neither is two days after", () => {
  const t = trip({ id: "t1", session_date: "2026-09-04" });
  assert.equal(recoveryTrips([t], { y: 2026, m: 9, d: 4 }).length, 0);
  assert.equal(recoveryTrips([t], { y: 2026, m: 9, d: 6 }).length, 0);
});

test("with no session date the travel end stands in, since that was the day", () => {
  const t = trip({ id: "t1", end_date: "2026-09-04", title: "Cygnet workshop" });
  assert.equal(sessionDayKey(t), "2026-09-04");
  const line = recoveryLine(recoveryTrips([t], SEP_5));
  assert.ok(line);
  assert.ok(line!.includes("Cygnet workshop"));
});

test("a session date beats the travel end, because that is the day he taught", () => {
  // He travels back the day after teaching. The recovery day follows the
  // teaching, not the train.
  const t = trip({ id: "t1", session_date: "2026-09-04", end_date: "2026-09-05" });
  assert.equal(sessionDayKey(t), "2026-09-04");
  assert.equal(recoveryTrips([t], SEP_5).length, 1);
  assert.equal(recoveryTrips([t], { y: 2026, m: 9, d: 6 }).length, 0);
});

test("a cancelled trip never earns a recovery day", () => {
  const t = trip({ id: "t1", session_date: "2026-09-04", status: "cancelled" });
  assert.equal(recoveryTrips([t], SEP_5).length, 0);
});

test("a trip with no dates at all says nothing", () => {
  const t = trip({ id: "t1" });
  assert.equal(sessionDayKey(t), null);
  assert.equal(recoveryTrips([t], SEP_5).length, 0);
  assert.equal(recoveryLine([]), null);
});

test("two sessions on one day are counted, not listed twice as one", () => {
  const a = trip({ id: "a", session_label: "L1D2", session_date: "2026-09-04" });
  const b = trip({ id: "b", session_label: "L2D1", session_date: "2026-09-04" });
  const line = recoveryLine(recoveryTrips([a, b], SEP_5));
  assert.ok(line);
  assert.ok(line!.includes("2 sessions"));
  assert.ok(line!.includes("L1D2"));
  assert.ok(line!.includes("L2D1"));
});

test("the label falls back to the trip title when there is no session label", () => {
  assert.equal(sessionLabel(trip({ id: "a", title: "Rajkot batch" })), "Rajkot batch");
  assert.equal(
    sessionLabel(trip({ id: "a", session_label: "L1D2", cities: ["Rajkot"] })),
    "L1D2, Rajkot"
  );
});

test("it observes and never blocks: no decline, no calendar hold", () => {
  const mod = src("lib/health/recovery.ts");
  const home = src("app/(app)/page.tsx");
  // It computes and returns a sentence. It writes nothing, calls no reminder
  // writer, and never reaches a calendar.
  for (const forbidden of [
    "createEvent",
    "syncTaskReminder",
    "writeReminder",
    "supabase",
    ".insert(",
    ".update(",
  ]) {
    assert.ok(
      !mod.includes(forbidden),
      `lib/health/recovery.ts must not use ${forbidden}: it is an observation`
    );
  }
  // Home renders the line and the advice, and nothing else acts on it.
  assert.ok(home.includes("recoveryLine("));
  assert.ok(home.includes("RECOVERY_ADVICE"));
  assert.ok(RECOVERY_ADVICE.length > 0);
});

test("the assistant is told the fact and the duty, both above the persona", () => {
  // The fact reaches it through the app context, from the same pure function
  // Home reads, so the screen and the chat cannot disagree.
  const context = src("lib/assistant/context.ts");
  assert.ok(context.includes("recoveryTrips("));
  assert.ok(context.includes("recoveryLine("));
  // The duty is in HARD_RULES, which sits above the persona block, so a
  // hostile persona cannot argue it away (the ordering proof is in m4).
  assert.ok(HARD_RULES.includes("Health"));
  assert.ok(HARD_RULES.includes("full-day session"));
  assert.ok(HARD_RULES.includes("never decline anything on his behalf"));
});

test("Health is a work stream of its own, and nothing is moved into it", () => {
  const migration = src(MIGRATION);
  assert.ok(migration.includes("'Health'"));
  // Seeded for the existing owner and for any future first sign-in.
  assert.ok(migration.includes("from auth.users"));
  assert.ok(migration.includes("seed_new_user"));
  // His Personal tasks stay where they are: which of them is health work is
  // his judgment, not a string match on a title.
  assert.ok(!/update\s+tasks/i.test(migration));
  assert.ok(!/work_stream_id\s*=/.test(migration));
});

// ---------------------------------------------------------------------------
// 4. The in-app chat is gone (B24, replaces the B6 thread tests)
// ---------------------------------------------------------------------------
// The thread code (chat-store.ts, chat-history.ts, chat.tsx) was removed on
// 29 September 2026: conversation happens in Claude through the connector.
// The assistant_chat_turns table stays, unread, until a later migration
// drops it; the migration's owner-only guarantees are still checked below.

test("the chat thread code is deleted and nothing reads the table any more", () => {
  for (const gone of [
    "lib/assistant/chat-store.ts",
    "lib/assistant/chat-history.ts",
    "components/assistant/chat.tsx",
    "app/api/assistant/chat/route.ts",
  ]) {
    assert.ok(!existsSync(new URL("../" + gone, import.meta.url)), `${gone} must stay deleted`);
  }
  for (const file of [
    "app/(app)/assistant/actions.ts",
    "app/(app)/assistant/page.tsx",
    "app/(app)/settings/actions.ts",
  ]) {
    const text = src(file);
    assert.ok(!text.includes("chat-store"), `${file} must not import the chat store`);
    assert.ok(!text.includes("chat-history"), `${file} must not import the chat history`);
    assert.ok(!text.includes("assistant_chat_turns"), `${file} must not touch the chat table`);
  }
});

// ---------------------------------------------------------------------------
// 5. No tool can read the transcript
// ---------------------------------------------------------------------------

const TOOL_SURFACES = [
  "lib/assistant/tools.ts",
  "lib/assistant/execute.ts",
  "lib/assistant/core.ts",
  "lib/assistant/mcp-api.ts",
  "lib/assistant/scan.ts",
  "lib/assistant/context.ts",
  "app/api/mcp/route.ts",
  "app/api/mcp/http/route.ts",
];

test("no tool surface names the chat table", () => {
  for (const file of TOOL_SURFACES) {
    const text = src(file);
    assert.ok(
      !text.includes("assistant_chat_turns"),
      `${file} must not touch assistant_chat_turns`
    );
    assert.ok(
      !text.includes("chat-store"),
      `${file} must not import the chat store`
    );
  }
});

test("no tool, on either surface, is about the transcript", () => {
  const shady = /chat|transcript|conversation/i;
  for (const t of TOOLS) {
    assert.ok(!shady.test(t.name), `${t.name} looks like a transcript tool`);
    const params = Object.keys(
      (t.input_schema as { properties?: Record<string, unknown> }).properties ?? {}
    );
    for (const p of params) {
      assert.ok(!shady.test(p), `${t.name}.${p} looks like a transcript parameter`);
    }
  }
  for (const name of MCP_READ_TOOLS) {
    assert.ok(!shady.test(name), `${name} looks like a transcript tool`);
  }
});

test("the connectors cannot reach the table even without RLS", () => {
  // The MCP connectors authenticate as service_role, which bypasses RLS
  // entirely. Only a revoked grant stops them, so the migration revokes it.
  const migration = src(MIGRATION);
  assert.ok(
    /revoke all on table public\.assistant_chat_turns from service_role/.test(migration)
  );
  assert.ok(migration.includes("enable row level security"));
  assert.ok(migration.includes("create policy owner_all on assistant_chat_turns"));
});

// ---------------------------------------------------------------------------
// 6. The confidential boundary, on Brain
// ---------------------------------------------------------------------------

const FILE_SHAPED =
  /^(file|upload|attachment|document|content|base64|scan_of|photo|image|drive|path)/i;

test("no note field invites a document", () => {
  const migration = src(MIGRATION);
  const columns = [...migration.matchAll(/add column if not exists (\w+)/g)].map(
    (m) => m[1]
  );
  for (const c of columns) {
    assert.ok(!FILE_SHAPED.test(c), `column ${c} looks like a file`);
  }
  // No storage bucket, no upload path, anywhere in this milestone.
  for (const file of [
    MIGRATION,
    "app/(app)/brain/actions.ts",
    "app/(app)/brain/page.tsx",
    "components/brain/notes-panel.tsx",
    "components/brain/people-panel.tsx",
    "lib/brain/notes.ts",
  ]) {
    const text = src(file);
    assert.ok(!/storage\.from|createBucket|type="file"|FormData/.test(text), file);
  }
});

test("every tool parameter still carries one concrete type", () => {
  for (const t of TOOLS) {
    const props =
      (t.input_schema as { properties?: Record<string, { type?: unknown }> }).properties ?? {};
    for (const [name, def] of Object.entries(props)) {
      assert.ok(
        !Array.isArray(def.type),
        `${t.name}.${name} carries a union type; the house rule is one concrete type`
      );
    }
  }
});

test("a note reference is a loose link, so deleting the work keeps the note", () => {
  const migration = src(MIGRATION);
  assert.ok(
    /task_id uuid references tasks \(id\) on delete set null/.test(migration)
  );
  assert.ok(
    /trip_id uuid references trips \(id\) on delete set null/.test(migration)
  );
});

test("a reference that is shown can be followed", () => {
  const panel = src("components/brain/notes-panel.tsx");
  assert.ok(panel.includes("/tasks?task="));
  assert.ok(panel.includes("/trips/"));
  assert.ok(panel.includes("/brain?tab=people&person="));
  // And the task link has somewhere to land: /tasks reads ?task= and opens
  // that drawer, since there is no page for a single task.
  const tasksPage = src("app/(app)/tasks/page.tsx");
  assert.ok(tasksPage.includes("sp.task"));
  assert.ok(tasksPage.includes("openTaskId"));
  assert.ok(src("components/tasks/tasks-view.tsx").includes("openTaskId"));
});

test("the note tools can link a note to a task and a trip", () => {
  for (const name of ["add_note", "update_note"]) {
    const tool = TOOLS.find((t) => t.name === name)!;
    // Optional, like every other read of a schema in these suites: ToolSchema
    // carries an index signature, and TypeScript 5.9 refuses the assertion
    // that a required property is definitely there.
    const props =
      (tool.input_schema as { properties?: Record<string, unknown> }).properties ?? {};
    assert.ok(props.task_id, `${name} lost its task_id parameter`);
    assert.ok(props.trip_id, `${name} lost its trip_id parameter`);
    const req = ((tool.input_schema as { required?: string[] }).required ?? []);
    assert.ok(!req.includes("task_id") && !req.includes("trip_id"), "the links must stay optional");
  }
});

test("a session day in a back-to-back run is never a recovery day (8 October 2026)", () => {
  // Sessions on the 7th, 8th and 9th: the brief on the 8th must not call it
  // a rest day because the 7th was a session.
  const yesterday = trip({ id: "t1", session_date: "2026-10-07", cities: ["Bengaluru"] });
  const todayTrip = trip({ id: "t2", session_date: "2026-10-08", cities: ["Delhi"] });
  const tomorrow = trip({ id: "t3", session_date: "2026-10-09", cities: ["Surat"] });
  const oct8: CivilDate = { y: 2026, m: 10, d: 8 };
  assert.equal(recoveryTrips([yesterday, todayTrip, tomorrow], oct8).length, 0);
  // A cancelled session today does not cancel the recovery day.
  const cancelled = trip({ id: "t2", session_date: "2026-10-08", status: "cancelled" });
  assert.equal(recoveryTrips([yesterday, cancelled], oct8).length, 1);
  // The 10th, with nothing on, is the recovery day after the 9th.
  assert.equal(recoveryTrips([yesterday, todayTrip, tomorrow], { y: 2026, m: 10, d: 10 }).length, 1);
});
