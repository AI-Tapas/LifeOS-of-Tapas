// B36: the icai mailbox is a normal mailbox for the mail tools, and a queued
// email can be saved to drafts. The calendar of icai stays read-only.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { checkMailSlot, listInbox, type MailAccount, type MailRequest } from "../lib/assistant/mailbox.ts";
import { saveQueuedToDrafts, type QueuedDraftDeps } from "../lib/assistant/queued-draft.ts";
import { parseMessageRef } from "../lib/assistant/task-mail.ts";
import { MAIL_SLOTS, toolByName } from "../lib/assistant/tools.ts";
import { SLOTS, lacksDraftScope, slotByKey } from "../lib/accounts.ts";

const src = (rel: string) => readFileSync(new URL("../" + rel, import.meta.url), "utf8");
const GMAIL = "https://gmail.googleapis.com/gmail/v1/users/me";
const ICAI: MailAccount = { id: "acc-icai", slot: "icai", provider: "google", email: "tapas@icai.org" };

test("icai is accepted by every mail tool check", () => {
  assert.equal(checkMailSlot("icai"), "icai");
  assert.ok(MAIL_SLOTS.includes("icai"));
  assert.equal(parseMessageRef("gmail:icai:m1")?.slot, "icai");
  for (const name of ["send_email", "draft_email", "save_reply_draft"]) {
    const s = toolByName(name)!.input_schema as unknown as { properties: { account: { enum: string[] } } };
    assert.ok(s.properties.account.enum.includes("icai"), `${name} enum has icai`);
  }
  // Calendar writes stay closed to icai.
  for (const name of ["add_event_solo", "propose_event_with_invites"]) {
    const s = toolByName(name)!.input_schema as unknown as { properties: { account: { enum: string[] } } };
    assert.equal(s.properties.account.enum.includes("icai"), false, `${name} still excludes icai`);
  }
  assert.match(src("lib/events/write.ts"), /data\.slot === "icai"\) throw new ReadOnlyAccountError/);
  for (const f of ["lib/assistant/mailbox.ts", "lib/assistant/task-mail.ts", "lib/assistant/attachment.ts", "lib/assistant/mcp-api.ts"]) {
    assert.doesNotMatch(src(f), /not open to these mail tools|icai is not available|never icai/, f);
  }
});

test("icai has the same scopes as ca_tapasnr and Reconnect shows until regranted", () => {
  const icai = slotByKey("icai")!;
  assert.deepEqual(icai.scopes, slotByKey("ca_tapasnr")!.scopes);
  assert.equal(lacksDraftScope(icai, ["https://www.googleapis.com/auth/gmail.readonly"]), true);
  assert.equal(lacksDraftScope(icai, icai.scopes), false);
  assert.ok(SLOTS.some((s) => s.key === "icai" && s.allowForwarded), "forwarded fallback kept");
});

test("listInbox works on an icai account", async () => {
  const calls: string[] = [];
  const request: MailRequest = async (url) => {
    calls.push(url);
    if (url.startsWith(`${GMAIL}/messages?`)) return new Response(JSON.stringify({ messages: [] }));
    return new Response("{}", { status: 404 });
  };
  const r = await listInbox(request, ICAI, { max: 5 }, new Date("2026-10-15T00:00:00Z"));
  assert.deepEqual(r.items, []);
  assert.equal(calls.length, 1);
});

// ---------------------------------------------------------------------------
// Part B: Save to drafts
// ---------------------------------------------------------------------------

const GRAPH = "https://graph.microsoft.com/v1.0/me";
const MS: MailAccount = { id: "acc-ms", slot: "altechon", provider: "microsoft", email: "tapas@altechon.example" };

interface Call { method: string; url: string; body: string }

function harness(account: MailAccount, payload: Record<string, unknown>, opts: { status?: string; providerStatus?: number; markFails?: boolean } = {}) {
  const calls: Call[] = [];
  const state = { status: opts.status ?? "proposed", result: null as Record<string, unknown> | null, audits: 0 };
  const request: MailRequest = async (url, init = {}) => {
    calls.push({ method: (init.method ?? "GET").toUpperCase(), url, body: typeof init.body === "string" ? init.body : "" });
    if (opts.providerStatus && opts.providerStatus >= 400) return new Response("{}", { status: opts.providerStatus });
    return new Response(JSON.stringify({ id: "d1", message: { id: "gm1" }, lastModifiedDateTime: "2026-10-15T10:00:00Z" }), { status: 200 });
  };
  const deps: QueuedDraftDeps = {
    loadAction: async () => ({ id: "a1", kind: "send_email", status: state.status, payload: { account_id: account.id, ...payload } }),
    account: async () => account,
    request: () => request,
    markSaved: async (result) => {
      if (opts.markFails) throw new Error("db down");
      if (state.status !== "proposed") return false;
      state.status = "saved_as_draft";
      state.result = result;
      return true;
    },
    audit: async () => { state.audits++; },
  };
  return { calls, state, deps };
}

const MAIL = { to: ["a@client.example"], cc: ["b@client.example"], subject: "Fee note", body: "Dear Sir, please find the note." };

test("Gmail: a new draft is created in the sending mailbox, nothing is sent, the action closes", async () => {
  const h = harness(ICAI, MAIL);
  const r = await saveQueuedToDrafts(h.deps);
  assert.deepEqual(r, { ok: true, message: "Saved to drafts in icai" });
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].method, "POST");
  assert.equal(h.calls[0].url, `${GMAIL}/drafts`);
  const raw = Buffer.from(JSON.parse(h.calls[0].body).message.raw, "base64url").toString("utf8");
  assert.match(raw, /^From: tapas@icai\.org/m);
  assert.match(raw, /^To: a@client\.example/m);
  assert.match(raw, /^Cc: b@client\.example/m);
  assert.doesNotMatch(raw, /X-Life-OS/i);
  assert.equal(h.state.status, "saved_as_draft");
  assert.equal(h.state.result?.mailbox, "icai");
  assert.equal(h.state.audits, 1);
  for (const c of h.calls) assert.doesNotMatch(c.url, /\/send|sendMail/);
});

test("Graph: a new draft is created with the approved recipients, subject and body", async () => {
  const h = harness(MS, MAIL);
  const r = await saveQueuedToDrafts(h.deps);
  assert.equal(r.ok, true);
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].url, `${GRAPH}/messages`);
  const b = JSON.parse(h.calls[0].body);
  assert.equal(b.subject, "Fee note");
  assert.equal(b.body.content, MAIL.body);
  assert.deepEqual(b.toRecipients, [{ emailAddress: { address: "a@client.example" } }]);
  assert.equal(h.state.status, "saved_as_draft");
});

test("a reply (payload has a thread) goes through the reply draft path in the same thread", async () => {
  const h = harness(ICAI, { ...MAIL, subject: "Re: Query", thread_id: "th9" });
  // saveReplyDraft first reads the thread: answer it with one message.
  const calls = h.calls;
  h.deps.request = () => async (url, init = {}) => {
    calls.push({ method: (init.method ?? "GET").toUpperCase(), url, body: typeof init.body === "string" ? init.body : "" });
    if (url.startsWith(`${GMAIL}/threads/th9?`)) {
      return new Response(JSON.stringify({ messages: [{ id: "m1", labelIds: ["INBOX"], payload: { headers: [
        { name: "From", value: "a@client.example" }, { name: "To", value: "tapas@icai.org" },
        { name: "Subject", value: "Query" }, { name: "Message-ID", value: "<x@y>" } ] } }] }));
    }
    return new Response(JSON.stringify({ id: "d2", message: { id: "gm2" } }));
  };
  const r = await saveQueuedToDrafts(h.deps);
  assert.equal(r.ok, true);
  const post = calls.find((c) => c.method === "POST")!;
  assert.equal(post.url, `${GMAIL}/drafts`);
  assert.equal(JSON.parse(post.body).message.threadId, "th9");
  const raw = Buffer.from(JSON.parse(post.body).message.raw, "base64url").toString("utf8");
  // Exactly the approved payload, not the thread's sender.
  assert.match(raw, /^To: a@client\.example$/m);
  assert.match(raw, /^Cc: b@client\.example$/m);
  assert.match(raw, /^In-Reply-To: <x@y>$/m);
  assert.equal(calls.filter((c) => c.method === "POST").length, 1);
  assert.equal(h.state.status, "saved_as_draft");
});

test("a failed draft save keeps the action queued and says why", async () => {
  const h = harness(ICAI, MAIL, { providerStatus: 500 });
  const r = await saveQueuedToDrafts(h.deps);
  assert.equal(r.ok, false);
  assert.match(r.message, /still in the queue/);
  assert.equal(h.state.status, "proposed");
  assert.equal(h.state.audits, 0);
});

test("a bad header is refused before any provider call and the action stays queued", async () => {
  const h = harness(ICAI, { ...MAIL, subject: "Hi\r\nBcc: evil@example.com" });
  const r = await saveQueuedToDrafts(h.deps);
  assert.equal(r.ok, false);
  assert.equal(h.calls.length, 0);
  assert.equal(h.state.status, "proposed");
});

test("only a proposed send_email can be saved to drafts", async () => {
  for (const status of ["approved", "executed", "rejected", "saved_as_draft"]) {
    const h = harness(ICAI, MAIL, { status });
    const r = await saveQueuedToDrafts(h.deps);
    assert.equal(r.ok, false, status);
    assert.equal(h.calls.length, 0, status);
  }
});

test("if the queue cannot be updated after the draft exists, the owner is told to check Drafts", async () => {
  const h = harness(ICAI, MAIL, { markFails: true });
  const r = await saveQueuedToDrafts(h.deps);
  assert.equal(r.ok, false);
  assert.match(r.message, /Check Drafts/);
});

test("the button is owner-only: no MCP surface, tool or read can reach it", () => {
  for (const f of ["lib/assistant/tools.ts", "lib/assistant/mcp-api.ts", "lib/mcp/dispatch.ts", "lib/mcp/catalog.ts", "lib/mcp/operations.ts", "app/api/mcp/http/route.ts", "app/api/mcp/route.ts"]) {
    let text = "";
    try { text = src(f); } catch { continue; }
    assert.doesNotMatch(text, /saveQueuedEmailToDrafts|queued-draft|saveToDrafts/, f);
    // The status may be READ (history lists it) but never written from here.
    if (f !== "lib/assistant/mcp-api.ts") assert.doesNotMatch(text, /saved_as_draft/, f);
  }
  const api = src("lib/assistant/mcp-api.ts");
  for (const line of api.split("\n").filter((l) => l.includes("saved_as_draft"))) {
    assert.match(line, /\.in\("status", \[|shows status saved_as_draft/, line);
  }
  assert.doesNotMatch(api, /status:\s*"saved_as_draft"/);
  assert.match(src("app/(app)/assistant/actions.ts"), /export async function saveToDraftsAction/);
  const draft = src("lib/assistant/queued-draft.ts");
  assert.doesNotMatch(draft, /messages\/send|sendMail|\/send\b|createReply\b/);
  assert.match(src("supabase/migrations/20261015000700_saved_as_draft_guard.sql"), /new\.status = 'saved_as_draft' and old\.kind = 'send_email'/);
});

// ---------------------------------------------------------------------------
// Part C: send_email can carry the thread it replies to
// ---------------------------------------------------------------------------
import { threadReplyContext } from "../lib/assistant/mailbox.ts";
import { plainTextMime } from "../lib/assistant/mail-headers.ts";
import { hashPayload } from "../lib/assistant/core.ts";

test("send_email and draft_email take an optional thread_id, same slot rules", () => {
  for (const name of ["send_email", "draft_email"]) {
    const s = toolByName(name)!.input_schema as unknown as {
      properties: Record<string, { type: string; enum?: string[] }>;
      required: string[];
    };
    assert.equal(s.properties.thread_id.type, "string", name);
    assert.equal(s.required.includes("thread_id"), false, `${name}: optional`);
    assert.deepEqual(s.properties.account.enum, MAIL_SLOTS);
  }
});

test("the thread id is bound into the approval hash", () => {
  const base = { account_id: "a", to: ["x@y.example"], cc: [], subject: "S", body: "B" };
  assert.notEqual(hashPayload({ ...base, thread_id: "t1" }), hashPayload(base));
  assert.notEqual(hashPayload({ ...base, thread_id: "t1" }), hashPayload({ ...base, thread_id: "t2" }));
});

test("a reply MIME carries In-Reply-To and References, and refuses injected values", () => {
  const mime = plainTextMime({
    from: "tapas@icai.org", to: ["a@client.example"], cc: [], subject: "Re: Query", body: "ok",
    inReplyTo: "<m1@x>", references: "<m0@x> <m1@x>",
  });
  assert.match(mime, /^In-Reply-To: <m1@x>$/m);
  assert.match(mime, /^References: <m0@x> <m1@x>$/m);
  assert.throws(() => plainTextMime({
    from: "tapas@icai.org", to: ["a@client.example"], cc: [], subject: "S", body: "b", inReplyTo: "<m>\r\nBcc: e@x.example",
  }), /line breaks/);
});

test("threadReplyContext reads Gmail headers and the Graph last message, read only", async () => {
  const calls: string[] = [];
  const gm: MailRequest = async (url, init) => {
    calls.push(`${init?.method ?? "GET"} ${url}`);
    return new Response(JSON.stringify({ messages: [
      { id: "m1", threadId: "t", payload: { headers: [{ name: "Message-ID", value: "<m1@x>" }] } },
      { id: "m2", threadId: "t", payload: { headers: [{ name: "Message-ID", value: "<m2@x>" }, { name: "References", value: "<m1@x>" }, { name: "Subject", value: "Query" }] } },
    ] }));
  };
  const g = await threadReplyContext(gm, ICAI, "t");
  assert.deepEqual(g, { message_id: "<m2@x>", references: "<m1@x> <m2@x>", subject: "Query" });
  const gr: MailRequest = async (url, init) => {
    calls.push(`${init?.method ?? "GET"} ${url}`);
    return new Response(JSON.stringify({ value: [
      { id: "g1", receivedDateTime: "2026-10-01T00:00:00Z" }, { id: "g2", subject: "Notice", receivedDateTime: "2026-10-02T00:00:00Z" } ] }));
  };
  const gc = await threadReplyContext(gr, MS, "c1");
  assert.equal(gc.message_id, "g2");
  assert.equal(gc.subject, "Notice");
  assert.ok(calls.every((c) => c.startsWith("GET ")));
  const missing: MailRequest = async () => new Response("{}", { status: 404 });
  await assert.rejects(threadReplyContext(missing, ICAI, "nope"));
});

test("proposal validates the thread; approval sends it as a reply in that thread", () => {
  const exec = src("lib/assistant/execute.ts");
  const propose = exec.slice(exec.indexOf("async function proposeAction("), exec.indexOf("// Autonomous kinds: perform now"));
  assert.match(propose, /threadReplyContext\(mailRequest\(account\.id\), account, thread\)/);
  assert.match(propose, /subject = checkedHeader\(replySubject\(ctx\.subject\)/, "subject comes from the thread");
  assert.match(propose, /\.\.\.\(thread \? \{ thread_id: thread \} : \{\}\)/);
  const send = exec.slice(exec.indexOf("async function sendEmail("), exec.indexOf("// Reject and undo"));
  assert.match(send, /threadId: thread/);
  assert.match(send, /inReplyTo: ctx\.message_id/);
  assert.match(send, /messages\/\$\{encodeURIComponent\(ctx\.message_id\)\}\/reply/);
  assert.match(send, /toRecipients: to\.map/, "Graph reply uses exactly the approved recipients");
  assert.match(send, /body: \{ contentType: "Text", content: body \}/, "Graph reply body keeps line breaks");
  assert.doesNotMatch(send, /comment: body/);
  assert.match(send, /isScopeShortfall\(res\)\) throw new Error\(reconnectMessage/, "Gmail send 403 gives the reconnect hint");
  assert.match(src("components/assistant/queue.tsx"), /Reply in thread: \{item\.subject\}/);
});

test("Graph: Save to drafts on a reply makes createReply on the last message, then patches the approved fields", async () => {
  const h = harness(MS, { ...MAIL, subject: "Re: Notice", thread_id: "c1" });
  const calls = h.calls;
  h.deps.request = () => async (url, init = {}) => {
    calls.push({ method: (init.method ?? "GET").toUpperCase(), url, body: typeof init.body === "string" ? init.body : "" });
    if (url.startsWith(`${GRAPH}/messages?`)) return new Response(JSON.stringify({ value: [{ id: "g2", subject: "Notice", receivedDateTime: "2026-10-02T00:00:00Z" }] }));
    if (url.endsWith("/createReply")) return new Response(JSON.stringify({ id: "shell1" }));
    return new Response(JSON.stringify({ lastModifiedDateTime: "2026-10-15T10:00:00Z" }));
  };
  const r = await saveQueuedToDrafts(h.deps);
  assert.equal(r.ok, true);
  assert.ok(calls.some((c) => c.method === "POST" && c.url === `${GRAPH}/messages/g2/createReply`));
  const patch = calls.find((c) => c.method === "PATCH")!;
  const b = JSON.parse(patch.body);
  assert.equal(b.subject, "Re: Notice");
  assert.deepEqual(b.toRecipients, [{ emailAddress: { address: "a@client.example" } }]);
  assert.deepEqual(b.ccRecipients, [{ emailAddress: { address: "b@client.example" } }]);
  assert.deepEqual(b.body, { contentType: "Text", content: MAIL.body });
  for (const c of calls) assert.doesNotMatch(c.url, /\/send|sendMail|\/reply$/);
});

test("queued-draft no longer uses the thread-derived reply draft", () => {
  assert.doesNotMatch(src("lib/assistant/queued-draft.ts"), /saveReplyDraft/);
});
