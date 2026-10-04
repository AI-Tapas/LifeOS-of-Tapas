// B34 offline proof: the nightly scan lists a second, targeted set of
// ticket and cab receipt mail per mailbox, so a busy day of circulars cannot
// push a ticket out of the newest-15 window. Run: npm run test:b34
//
// Synthetic data only. The real scan and the real mail.ts run; the model,
// Supabase and the token layer are the b24 stand-ins (b34-loader.mjs), and
// fetch is replaced by a fake Gmail and Graph below.

import { register } from "node:module";
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  CAB_RECEIPT_SENDERS,
  TICKET_SENDER_ADDRESSES,
  TICKET_SENDER_DOMAINS,
  mailReadSenders,
  mayReadMailContent,
} from "../lib/assistant/scan-filters.ts";
import { MAX_TARGETED_MESSAGES, TARGETED_MESSAGES, targetedCap } from "../lib/assistant/scan-args.ts";
import { fakeSupabase, resetState, state } from "./b24-stubs.ts";

register("./b34-loader.mjs", import.meta.url);
const { runMailScan } = await import("../lib/assistant/scan.ts");
const { listRecentGmail, listRecentGraph } = await import("../lib/assistant/mail.ts");

const src = (rel: string) => readFileSync(new URL("../" + rel, import.meta.url), "utf8");
const OWNER = { supabase: fakeSupabase, userId: "user-1", origin: "owner_session", job: null } as never;
const DAY = 86400000;
const TICKET_FROM = "ICAI Travel Desk <traveldesk@icai.in>";

// --- fake Gmail and Graph -----------------------------------------------------
const net = {
  lists: [] as { kind: "gmail" | "graph"; q: string; max: number; orderby?: string; select?: string }[],
  graphCalls: 0,
  fullReads: [] as string[],
  failTargeted: false,
  graphOnly: [] as { id: string; from: string; subject: string; date: string }[],
};
function resetNet() {
  net.lists = [];
  net.graphCalls = 0;
  net.fullReads = [];
  net.failTargeted = false;
}
const byNewest = <T extends { date: string }>(rows: T[]) =>
  [...rows].sort((a, b) => Date.parse(b.date) - Date.parse(a.date));

const fakeFetch = async (input: RequestInfo | URL): Promise<Response> => {
  const url = new URL(String(input));
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  if (url.hostname === "gmail.googleapis.com") {
    const msg = /\/messages\/([^/?]+)$/.exec(url.pathname);
    if (msg) {
      const m = state.mails.find((x) => x.id === msg[1]);
      if (!m) return json({}, 404);
      if (url.searchParams.get("format") === "full") net.fullReads.push(m.id);
      return json({
        id: m.id,
        threadId: m.threadId,
        snippet: m.snippet,
        payload: {
          mimeType: "text/plain",
          body: { size: 0 },
          headers: [
            { name: "From", value: m.from },
            { name: "Subject", value: m.subject },
            { name: "Date", value: m.date },
          ],
        },
      });
    }
    const q = url.searchParams.get("q") ?? "";
    const max = Number(url.searchParams.get("maxResults"));
    net.lists.push({ kind: "gmail", q, max });
    const targeted = q.includes("from:(");
    if (targeted && net.failTargeted) return json({}, 500);
    const rows = byNewest(state.mails).filter((m) => !targeted || mayReadMailContent(m.from));
    return json({ messages: rows.slice(0, max).map((m) => ({ id: m.id, threadId: m.threadId })) });
  }
  if (url.hostname === "graph.microsoft.com") {
    const filter = url.searchParams.get("$filter") ?? "";
    const max = Number(url.searchParams.get("$top"));
    net.lists.push({
      kind: "graph",
      q: filter,
      max,
      orderby: url.searchParams.get("$orderby") ?? "",
      select: url.searchParams.get("$select") ?? "",
    });
    net.graphCalls += 1;
    // The second Graph call of a scan is the targeted one.
    if (net.graphCalls === 2 && net.failTargeted) return json({}, 500);
    const rows = byNewest(net.graphOnly);
    return json({
      value: rows.slice(0, max).map((m) => ({
        id: m.id,
        conversationId: `c-${m.id}`,
        subject: m.subject,
        from: { emailAddress: { name: "", address: m.from } },
        receivedDateTime: new Date(m.date).toISOString(),
        bodyPreview: "Synthetic.",
      })),
    });
  }
  return json({}, 404);
};
globalThis.fetch = fakeFetch as typeof fetch;

// --- fixtures -------------------------------------------------------------------
const TOPICS = ["Kestrel", "Lumina", "Orchid", "Vega", "Zephyr", "Quartz", "Nimbus", "Falcon", "Harbor", "Meridian",
  "Sable", "Tundra", "Willow", "Cobalt", "Juniper", "Basalt", "Pebble", "Ember", "Saffron", "Indigo", "Maple", "Onyx"];
const stamp = (ageMs: number) => new Date(Date.now() - ageMs).toUTCString();

function circulars(n: number) {
  return Array.from({ length: n }, (_, i) => {
    const k = String(i + 1).padStart(2, "0");
    return {
      id: `m${k}`,
      from: `Person ${k} <person${k}@example.test>`,
      subject: `Question ${k} about ${TOPICS[i]}`,
      date: stamp(3600000 * (i + 1)),
      snippet: `Synthetic note ${k}.`,
      threadId: `thread-${k}`,
    };
  });
}
const ticket = (id = "t01", ageMs = 2 * DAY) => ({
  id,
  from: TICKET_FROM,
  subject: "E-ticket for the coming session",
  date: stamp(ageMs),
  snippet: "Tickets attached.",
  threadId: `thread-${id}`,
});

// The stub model records what the task pass was shown and proposes nothing.
let shownToModel: number[] = [];
function watchModel() {
  shownToModel = [];
  state.llm = (refs) => {
    shownToModel.push(refs.length);
    return { text: "", stop: "end", calls: [] };
  };
}
const lastScanAudit = () =>
  state.audit.filter((a) => a.action === "mail_scan").at(-1)!.meta as Record<string, unknown>;

// --- tests ----------------------------------------------------------------------
test("busy day: 20 circulars and a ticket from 2 days ago; the ticket is read, the task pass sees 15", async () => {
  resetState();
  resetNet();
  watchModel();
  state.mails = [...circulars(20), ticket()];
  const summary = await runMailScan(OWNER, { account: "icai" });

  assert.deepEqual(net.fullReads, ["t01"], "the ticket mail reached the ticket pass");
  const meta = lastScanAudit();
  assert.equal(meta.tickets_read, 1);
  assert.equal(meta.targeted_read, 1, "one message came only from the targeted fetch");
  assert.equal(meta.scanned, 16, "15 newest plus the one extra");
  assert.equal(summary.scanned, 16);
  assert.equal(Math.max(...shownToModel), 15, "the task pass still sees at most 15");
  assert.ok(shownToModel.every((n) => n <= 15));
  // The audit row carries counts only.
  assert.ok(!JSON.stringify(meta).includes("traveldesk"));
});

test("overlap: the same message in both lists is listed and read once", async () => {
  resetState();
  resetNet();
  watchModel();
  state.mails = [...circulars(5), ticket("t01", 1000)];
  await runMailScan(OWNER, { account: "icai" });
  assert.deepEqual(net.fullReads, ["t01"], "read once, not twice");
  const meta = lastScanAudit();
  assert.equal(meta.scanned, 6);
  assert.equal(meta.targeted_read, 0, "nothing came only from the targeted list");

  const merged = await listRecentGmail("acc-icai");
  assert.equal(new Set(merged.map((m) => m.id)).size, merged.length, "no duplicate ids");
  assert.equal(merged.length, 6);
});

test("the merged list is newest first", async () => {
  resetState();
  resetNet();
  state.mails = [...circulars(20), ticket("t01", 2 * DAY)];
  const merged = await listRecentGmail("acc-icai");
  assert.equal(merged.length, 16);
  assert.equal(merged.at(-1)!.id, "t01", "the oldest message, the extra one, sits last");
  assert.ok(merged.at(-1)!.targeted);
  const times = merged.map((m) => Date.parse(m.date));
  assert.deepEqual(times, [...times].sort((a, b) => b - a));
});

test("sender list: the query's senders equal the allowlists, with no second copy anywhere", async () => {
  resetState();
  resetNet();
  state.mails = circulars(2);
  await listRecentGmail("acc-icai");
  const targeted = net.lists.find((l) => l.q.includes("from:("))!;
  const inQuery = /from:\((.*)\)$/.exec(targeted.q)![1].split(" OR ");
  const expected = [
    ...TICKET_SENDER_ADDRESSES,
    ...TICKET_SENDER_DOMAINS,
    ...CAB_RECEIPT_SENDERS.map((s) => s.match),
  ];
  assert.deepEqual([...inQuery].sort(), [...expected].sort());
  assert.deepEqual(mailReadSenders().sort(), [...expected].sort());
  assert.match(targeted.q, /^newer_than:3d in:inbox from:\(/);

  // Every entry is really read-allowed, so the list cannot name a sender the
  // content rule would refuse.
  for (const s of expected) {
    assert.ok(mayReadMailContent(s.includes("@") ? s : `x@${s}`), `${s} must be a readable sender`);
  }
  // A sender spelled out in mail.ts, scan.ts or scan-args.ts is a second
  // copy: this fails if anyone adds one there instead of in scan-filters.ts.
  for (const file of ["lib/assistant/mail.ts", "lib/assistant/scan.ts", "lib/assistant/scan-args.ts"]) {
    const text = src(file);
    for (const s of expected) assert.ok(!text.includes(s), `${file} must not carry its own copy of ${s}`);
  }
  // The query is built from constants only: no mail field reaches it.
  assert.ok(src("lib/assistant/mail.ts").includes("mailReadSenders()"));
});

test("Graph: non-allowlisted senders in the deeper page are dropped, allowlisted ones kept, at most the cap", async () => {
  resetState();
  resetNet();
  net.graphOnly = [
    ...circulars(15).map((m) => ({ id: m.id, from: `p${m.id}@example.test`, subject: m.subject, date: m.date })),
    { id: "g1", from: "someone@example.test", subject: "Plain mail", date: stamp(DAY) },
    { id: "g2", from: "x@notirctc.co.in.example.test", subject: "Lookalike", date: stamp(DAY + 1000) },
    { id: "g-ok", from: "etickets@sharpmail.in", subject: "E-ticket", date: stamp(2 * DAY) },
    ...Array.from({ length: 14 }, (_, i) => ({
      id: `g-uber${i}`,
      from: "Uber <noreply@uber.com>",
      subject: `Trip ${i}`,
      date: stamp(3 * DAY + i * 1000),
    })),
  ];
  const out = await listRecentGraph("acc-alt");
  const extras = out.filter((m) => m.targeted);
  assert.ok(extras.every((m) => mayReadMailContent(m.from)), "only allowlisted senders come in");
  assert.ok(!out.some((m) => m.id === "g1" || m.id === "g2"), "plain and lookalike senders are dropped");
  assert.ok(extras.some((m) => m.id === "g-ok"));
  assert.equal(extras.length, 10, "at most the cap of 10 extras");
});

test("catch-up: with days 10 the targeted cap scales and never exceeds 50", async () => {
  assert.equal(TARGETED_MESSAGES, 10);
  assert.equal(MAX_TARGETED_MESSAGES, 50);
  assert.equal(targetedCap(1), 10);
  assert.equal(targetedCap(3), 10);
  assert.equal(targetedCap(4), 40);
  assert.equal(targetedCap(5), 50);
  assert.equal(targetedCap(10), 50);
  assert.equal(targetedCap(14), 50);

  resetState();
  resetNet();
  watchModel();
  state.mails = [...circulars(20), ticket("t01", 8 * DAY)];
  await runMailScan(OWNER, { days: 10, account: "icai" });
  const main = net.lists.find((l) => !l.q.includes("from:("))!;
  const targeted = net.lists.find((l) => l.q.includes("from:("))!;
  assert.equal(main.max, 150);
  assert.equal(targeted.max, 50);
  assert.ok(targeted.q.startsWith("newer_than:10d in:inbox from:("));
  assert.ok(net.fullReads.includes("t01"));

  // And the nightly run asks for 15 and 10.
  resetNet();
  await listRecentGmail("acc-icai");
  assert.deepEqual(net.lists.map((l) => l.max), [15, 10]);
});

test("altechon: the Graph path does the same, with a server filter on date only", async () => {
  resetState();
  resetNet();
  net.graphOnly = [
    ...circulars(20).map((m) => ({ id: m.id, from: `p${m.id}@example.test`, subject: m.subject, date: m.date })),
    { id: "g-ticket", from: "etickets@sharpmail.in", subject: "E-ticket", date: stamp(2 * DAY) },
  ];
  const out = await listRecentGraph("acc-alt");
  assert.equal(out.length, 16);
  assert.ok(out.some((m) => m.id === "g-ticket" && m.targeted));
  const [main, targeted] = net.lists;
  assert.equal(main.max, 15);
  assert.equal(targeted.max, 30, "three times the targeted cap");
  for (const l of [main, targeted]) {
    assert.match(l.q, /^receivedDateTime ge \S+$/, "no sender clause on the server");
    assert.equal(l.orderby, "receivedDateTime desc");
    assert.equal(l.select, "id,conversationId,subject,from,receivedDateTime,bodyPreview", "metadata only");
  }
  // Catch-up scales the same way (3 x 50).
  resetNet();
  await listRecentGraph("acc-alt", { days: 10, messages: 150 });
  assert.deepEqual(net.lists.map((l) => l.max), [150, 150]);
});

test("a failed targeted fetch leaves the newest-15 list intact and never fails the scan", async () => {
  resetState();
  resetNet();
  state.mails = circulars(20);
  net.failTargeted = true;
  const out = await listRecentGmail("acc-icai");
  assert.equal(out.length, 15);
  net.graphOnly = circulars(4).map((m) => ({ id: m.id, from: "a@example.test", subject: m.subject, date: m.date }));
  net.graphCalls = 0;
  let flagged = 0;
  const g = await listRecentGraph("acc-alt", undefined, () => (flagged += 1));
  assert.equal(g.length, 4);
  assert.equal(flagged, 1, "the Graph failure is reported to the caller");
});

test("a failed targeted fetch is recorded: targeted_failed in the audit row and a scan note", async () => {
  resetState();
  resetNet();
  watchModel();
  state.mails = circulars(5);
  net.failTargeted = true;
  const summary = await runMailScan(OWNER, { account: "icai" });
  assert.equal(lastScanAudit().targeted_failed, true);
  assert.equal(lastScanAudit().targeted_read, 0);
  assert.ok(summary.notes.some((n) => n.startsWith("icai:") && n.includes("check failed")));

  resetState();
  resetNet();
  watchModel();
  state.mails = circulars(5);
  const ok = await runMailScan(OWNER, { account: "icai" });
  assert.equal(lastScanAudit().targeted_failed, false, "a flag only, false when it worked");
  assert.ok(!ok.notes.some((n) => n.includes("check failed")));
});

test("the content rule is untouched: mayReadMailContent is still the two allowlists and nothing else", () => {
  assert.ok(mayReadMailContent("traveldesk@icai.in"));
  assert.ok(mayReadMailContent("Uber <noreply@uber.com>"));
  assert.ok(!mayReadMailContent("circular@icai.in"));
  const filters = src("lib/assistant/scan-filters.ts");
  assert.match(
    filters,
    /export function mayReadMailContent\(from: string\): boolean \{\s*return isTicketSender\(from\) \|\| isCabReceiptSender\(from\);\s*\}/
  );
});
