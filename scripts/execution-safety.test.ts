// Security regressions exercise actual executor/event writer bodies with only
// transport/database boundaries replaced. No credentials or real delivery.
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import * as crypto from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { checkedAddresses, checkedHeader, encodedSubject, plainTextMime } from "../lib/assistant/mail-headers.ts";
const require = createRequire(import.meta.url);
const { load, database } = require("./execution-harness.mjs");
const registry = load("lib/assistant/tools.ts");
const core = load("lib/assistant/core.ts", { ...registry, ...crypto });
const eventPayload = load("lib/events/payload.ts");
const headers = { checkedAddresses, checkedHeader, encodedSubject, plainTextMime };
function setup(extra = {}) {
  const db = database({
    accounts: [{ id: "account", user_id: "owner", email: "sender@example.test", slot: "ca_tapasnr", provider: "google", status: "connected", connect_mode: "direct" }],
    assistant_actions: [], audit_log: [],
  });
  const requests: { url: string; init: RequestInit }[] = [];
  const executor = load("lib/assistant/execute.ts", { ...registry, ...core, ...headers, AsyncLocalStorage, SAVE_DRAFT_TOOL: "save_reply_draft",
    withResourceAuth: async (_id: string, fn: (token: string) => unknown) => fn("synthetic"),
    fetch: async (url: string, init: RequestInit) => { requests.push({ url, init }); return Response.json({ id: "provider-id" }); },
    ...extra,
  });
  return { db, requests, executor, actor: { supabase: db, userId: "owner", origin: "owner_session", job: null } };
}
const mail = { account: "ca_tapasnr", to: ["approved@example.test"], subject: "A valid subject", body: "Synthetic only" };

test("mail proposal rejects controls and structural recipient injection before queueing", async () => {
  const { executor, actor, db, requests } = setup();
  for (const subject of ["Hello\r\nBcc: hidden@example.test", "Hello\nX: value", "Hello\0there", "Hello\u2028Bcc: hidden"]) {
    await assert.rejects(executor.executeToolCall("send_email", { ...mail, subject }, actor), /control characters/);
  }
  for (const recipient of ["a@example.test,b@example.test", "name <a@example.test>", "a..b@example.test", "a@example.test\r\nBcc:x@example.test"]) {
    await assert.rejects(executor.executeToolCall("send_email", { ...mail, to: [recipient] }, actor));
  }
  assert.equal(db.tables.assistant_actions.length, 0);
  assert.equal(requests.length, 0);
});

test("Unicode MIME preserves approved recipients and subject without new headers", async () => {
  const { executor, actor, requests } = setup();
  const subject = "नमस्ते 🌍 ".repeat(20);
  const pending = await executor.executeToolCall("send_email", { ...mail, subject, cc: ["copy@example.test"] }, actor);
  assert.equal(requests.length, 0);
  assert.equal((await executor.approveAndExecute(pending.actionId, actor)).ok, true);
  const mime = Buffer.from(JSON.parse(String(requests[0].init.body)).raw, "base64url").toString("utf8");
  assert.match(mime, /\r\nTo: approved@example.test\r\nCc: copy@example.test\r\n/);
  assert.doesNotMatch(mime, /\r\nBcc:/i);
  const words = [...mime.matchAll(/=\?UTF-8\?B\?([^?]+)\?=/g)];
  assert.equal(words.map((word) => Buffer.from(word[1], "base64").toString("utf8")).join(""), subject.trim());
  assert.ok(words.every((word) => word[0].length <= 75));
  assert.equal(mime.split("\r\n\r\n").length, 2);
});

test("execution revalidates legacy approved header values", async () => {
  const { executor, actor, db, requests } = setup();
  const payload = { account_id: "account", ...mail, subject: "Hello\r\nBcc: hidden@example.test" };
  db.tables.assistant_actions.push({ id: "legacy", kind: "send_email", status: "approved", payload, payload_hash: core.hashPayload(payload) });
  assert.equal((await executor.executeApprovedAction("legacy", actor)).ok, false);
  assert.equal(requests.length, 0);
});

test("provider accepted / final write failed is uncertain, preserves result, cannot resend", async () => {
  const { executor, actor, db, requests } = setup();
  const queued = await executor.executeToolCall("send_email", mail, actor);
  db.fail = (table: string, op: string, payload: { status?: string }) => table === "assistant_actions" && op === "update" && payload.status === "executed";
  const result = await executor.approveAndExecute(queued.actionId, actor);
  assert.equal(result.ok, false);
  assert.match(result.message, /provider accepted.*Do not send it again/);
  const row = db.tables.assistant_actions[0];
  assert.equal(row.execution_state, "uncertain");
  assert.equal(row.result.provider_message_id, "provider-id");
  assert.equal((await executor.executeApprovedAction(queued.actionId, actor)).ok, false);
  assert.equal(requests.length, 1);
});

test("autonomous action does not mutate if durable intent insert fails", async () => {
  const { executor, actor, db } = setup();
  db.fail = (table: string, op: string) => table === "assistant_actions" && op === "insert";
  await assert.rejects(executor.executeToolCall("add_note", { title: "Synthetic", type: "general", body: "content" }, actor), /Injected database failure/);
  assert.equal(db.calls.some((call: { table: string; op: string }) => call.table === "notes" && call.op === "insert"), false);
});

test("autonomous final persistence failure leaves durable intent and explicit uncertainty", async () => {
  const { executor, actor, db } = setup();
  db.fail = (table: string, op: string, payload: { status?: string }) => table === "assistant_actions" && op === "update" && payload.status === "executed";
  await assert.rejects(executor.executeToolCall("add_note", { title: "Synthetic", type: "general", body: "content" }, actor), /completed but final history.*Do not repeat/);
  assert.equal(db.tables.notes.length, 1);
  assert.equal(db.tables.assistant_actions[0].execution_state, "uncertain");
  assert.equal(db.tables.assistant_actions[0].result.undo.note_id, db.tables.notes[0].id);
});

test("failed local undo stays executed, exposes error and can retry successfully", async () => {
  const { executor, actor, db } = setup();
  db.tables.assistant_actions.push({ id: "undo", kind: "add_note", status: "executed", result: { undo: { note_id: "note" } } });
  db.tables.notes = [{ id: "note" }];
  db.fail = (table: string, op: string) => table === "notes" && op === "delete";
  assert.equal((await executor.undoExecutedAction("undo", actor)).ok, false);
  const row = db.tables.assistant_actions[0];
  assert.equal(row.status, "executed");
  assert.equal(row.undo_started_at, null);
  assert.match(row.undo_error, /Injected database failure/);
  assert.equal(db.tables.notes.length, 1);
  db.fail = null;
  assert.equal((await executor.undoExecutedAction("undo", actor)).ok, true);
  assert.equal(row.status, "undone");
  assert.equal(db.tables.notes.length, 0);
});

test("failed provider/multi-step undo remains claimed and cannot be blindly retried", async () => {
  let attempts = 0;
  const { executor, actor, db } = setup({ deleteTask: async () => { attempts++; return { ok: false, message: "Partial reminder failure" }; } });
  db.tables.assistant_actions.push({ id: "undo", kind: "create_task", status: "executed", result: { undo: { task_id: "task" } } });
  assert.equal((await executor.undoExecutedAction("undo", actor)).ok, false);
  assert.equal(db.tables.assistant_actions[0].status, "executed");
  assert.ok(db.tables.assistant_actions[0].undo_started_at);
  assert.equal((await executor.undoExecutedAction("undo", actor)).ok, false);
  assert.equal(attempts, 1);
});

test("concurrent undo claims perform one inverse", async () => {
  const { executor, actor, db } = setup();
  db.tables.assistant_actions.push({ id: "undo", kind: "add_note", status: "executed", result: { undo: { note_id: "note" } } });
  db.tables.notes = [{ id: "note" }];
  const outcomes = await Promise.all([executor.undoExecutedAction("undo", actor), executor.undoExecutedAction("undo", actor)]);
  assert.equal(outcomes.filter((result) => result.ok).length, 1);
  assert.equal(db.calls.filter((call: { table: string; op: string }) => call.table === "notes" && call.op === "delete").length, 1);
});

function calendar(provider = "microsoft", attendee = true, etag = '"v1"', mutationStatus = 200, attendeesOmitted = false) {
  const db = database({
    accounts: [{ id: "account", provider, slot: "ca_tapasnr", status: "connected" }],
    calendars: [{ id: "calendar", ext_calendar_id: "remote-calendar" }],
    events: [{ id: "event", user_id: "owner", account_id: "account", calendar_id: "calendar", ext_event_id: "remote-event", source: "app", attendees: null }],
  });
  const calls: { method: string; headers: Record<string, string>; body?: string }[] = [];
  const writer = load("lib/events/write.ts", { ...eventPayload, createServiceClient: () => db,
    withResourceAuth: async (_id: string, fn: (token: string) => unknown) => fn("synthetic"),
    fetch: async (_url: string, init: RequestInit) => {
      calls.push({ method: init.method ?? "GET", headers: init.headers as Record<string, string>, body: init.body as string });
      if (!init.method) return Response.json({ ...(etag ? { etag } : {}), attendeesOmitted, attendees: attendee ? [{ email: "guest@example.test" }] : [] });
      return Response.json({}, { status: mutationStatus });
    },
  });
  return { db, writer, calls };
}
const eventInput = { title: "Synthetic", startIso: "2026-10-15T10:00:00Z" };

test("provider guests added outside LifeOS block autonomous delete and edit", async () => {
  for (const provider of ["google", "microsoft"]) {
    const { writer, calls } = calendar(provider);
    await assert.rejects(writer.deleteAppEvent("owner", "event"), /Confirm to continue/);
    await assert.rejects(writer.updateEvent("owner", "event", eventInput, false), /Confirm to continue/);
    assert.ok(calls.every((call) => call.method === "GET"));
  }
});

test("confirmed edit preserves omitted guests and binds mutation to provider version", async () => {
  const { writer, calls, db } = calendar();
  await writer.updateEvent("owner", "event", eventInput, true);
  assert.equal(calls[1].method, "PATCH");
  assert.equal(calls[1].headers["if-match"], '"v1"');
  assert.equal(JSON.parse(calls[1].body!).attendees, undefined);
  assert.equal(db.tables.events[0].attendees[0].email, "guest@example.test");
});

test("confirmed guest cancellation has If-Match; solo writes require a version too", async () => {
  const { writer, calls } = calendar();
  await writer.deleteAppEvent("owner", "event", true);
  assert.equal(calls[1].method, "DELETE");
  assert.equal(calls[1].headers["if-match"], '"v1"');
  const unversioned = calendar("google", false, "");
  await assert.rejects(unversioned.writer.deleteAppEvent("owner", "event"), /no event version/);
  assert.equal(unversioned.calls.length, 1);
});

test("provider precondition failure does not delete local row", async () => {
  const { writer, calls, db } = calendar("google", false, '"old"', 412);
  await assert.rejects(writer.deleteAppEvent("owner", "event"), /412/);
  assert.equal(calls.length, 2);
  assert.equal(db.tables.events.length, 1);
});


test("undo cannot report success when an update target was deleted", async () => {
  const { executor, actor, db } = setup();
  db.tables.assistant_actions.push({ id: "undo", kind: "update_note", status: "executed", result: { undo: { note_id: "missing", prev: { title: "Before", body_md: "Before" } } } });
  const outcome = await executor.undoExecutedAction("undo", actor);
  assert.equal(outcome.ok, false);
  assert.match(outcome.message, /Expected exactly one row/);
  assert.equal(db.tables.assistant_actions[0].status, "executed");
});

test("an incomplete provider guest list cannot authorize a solo mutation", async () => {
  const { writer, calls } = calendar("google", false, '"v1"', 200, true);
  await assert.rejects(writer.deleteAppEvent("owner", "event"), /incomplete guest list/);
  assert.equal(calls.length, 1);
});

test("approval audit failure stops before any provider request and returns recovery guidance", async () => {
  const { executor, actor, db, requests } = setup();
  const queued = await executor.executeToolCall("send_email", mail, actor);
  db.fail = (table: string, op: string, payload: { action?: string }) => table === "audit_log" && op === "insert" && payload.action === "approve";
  const outcome = await executor.approveAndExecute(queued.actionId, actor);
  assert.equal(outcome.ok, false);
  assert.match(outcome.message, /Nothing was sent/);
  assert.equal(requests.length, 0);
  assert.equal(db.tables.assistant_actions[0].status, "failed");
});

test("provider event identity survives local persistence failure", async () => {
  const { writer, db, calls } = calendar("google", false);
  db.fail = (table: string, op: string) => table === "events" && op === "upsert";
  await assert.rejects(writer.updateEvent("owner", "event", eventInput, false), (error: unknown) => {
    const e = error as { providerResult: { ext_event_id: string }; message: string };
    assert.equal(e.providerResult.ext_event_id, "remote-event");
    assert.match(e.message, /provider accepted.*Do not repeat/);
    return true;
  });
  assert.equal(calls.filter((call) => call.method === "PATCH").length, 1);
});

test("approved executor persists a known provider result when local persistence throws", async () => {
  let retained: unknown = null;
  let failed = false;
  const payload = { synthetic: true };
  const result = await core.runApprovedExecution({
    loadAction: async () => ({ id: "intent", kind: "send_email", status: "approved", payload, payload_hash: core.hashPayload(payload) }),
    claimExecution: async () => true,
    perform: async () => { throw Object.assign(new Error("local save failed"), { providerResult: { ext_event_id: "remote-event" } }); },
    markExecuted: async () => { assert.fail("No complete local result"); },
    markFailed: async () => { failed = true; },
    markUncertain: async (_message: string, value: unknown) => { retained = value; },
    audit: async () => {},
  });
  assert.equal(result.ok, false);
  assert.equal(failed, false);
  assert.deepEqual(retained, { ext_event_id: "remote-event" });
});

test("a committed scanned expense remains successful when the supplementary audit fails", async () => {
  let expenses = 0;
  const ride = { trip_id: "trip", category: "transport", amount: 100, date: "2026-10-15" };
  const { executor, db, actor } = setup({
    cabActionPayload: (value: unknown) => value,
    cabDescription: () => "Synthetic expense",
    cabExpenseInput: (value: unknown) => value,
    formatDateIST: () => "15 October",
    addTripExpense: async () => { expenses++; return { ok: true, id: "expense" }; },
  });
  db.fail = (table: string, op: string, payload: { action?: string }) => table === "audit_log" && op === "insert" && payload.action === "execute_autonomous";
  const result = await executor.logScannedCabExpense(actor, ride, "account");
  assert.equal(expenses, 1);
  assert.ok(result.actionId);
  assert.match(result.auditWarning, /completed and was saved.*Do not repeat/);
  assert.equal(db.tables.assistant_actions[0].status, "executed");
  assert.equal(db.tables.assistant_actions[0].result.undo.expense_id, "expense");
});

test("preview note undo restores only the changed fields and preserves relationships", async () => {
  const { executor, actor, db } = setup();
  db.tables.notes = [{ id: "note", title: "After", body_md: "Owner edited later", task_id: "task", trip_id: "trip" }];
  db.tables.assistant_actions.push({ id: "undo", kind: "update_note", status: "executed", result: { undo: { note_id: "note", prev: { title: "Before" }, patch_only: true } } });
  assert.equal((await executor.undoExecutedAction("undo", actor)).ok, true);
  assert.deepEqual(db.tables.notes[0], { id: "note", title: "Before", body_md: "Owner edited later", task_id: "task", trip_id: "trip" });
});
