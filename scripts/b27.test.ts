// B27 offline proof: agents can find a task's email and read its files
// properly. Run: npm run test:b27
//
// The real connector read code runs against an in-memory database and a mocked
// mailbox (scripts/b27-stubs.ts, b27-loader.mjs). The Word reader and the
// attachment reader are driven directly. Synthetic data only.

import { register } from "node:module";
import test from "node:test";
import assert from "node:assert/strict";
import { deflateRawSync } from "node:zlib";
import { docxRead, docxText } from "../lib/assistant/docx-text.ts";
import {
  ATTACHMENT_TEXT_CAP,
  attachmentAuditRow,
  readMailAttachment,
  readMailAttachmentRecorded,
  type AttachmentAuditRow,
} from "../lib/assistant/attachment.ts";
import type { MailAccount, MailRequest } from "../lib/assistant/mailbox.ts";
import { parseMessageRef } from "../lib/assistant/task-mail.ts";
import { db, mail, resetDb } from "./b27-stubs.ts";

register("./b27-loader.mjs", import.meta.url);
const { runReadTool, READ_TOOL_SCHEMAS, READ_TOOL_DESCRIPTIONS } = await import("../lib/assistant/mcp-api.ts");

const GMAIL = "https://gmail.googleapis.com/gmail/v1/users/me";
const GRAPH = "https://graph.microsoft.com/v1.0/me";
const b64 = (s: string) => Buffer.from(s).toString("base64url");

const CA = { id: "acc-ca", slot: "ca_tapasnr", provider: "google", email: "ca@example.test", status: "connected", connect_mode: "direct" };
const AL = { id: "acc-al", slot: "altechon", provider: "microsoft", email: "al@example.test", status: "connected", connect_mode: "direct" };

function seed(): void {
  resetDb();
  mail.calls = [];
  mail.handler = () => new Response("{}", { status: 404 });
  db.accounts.push({ ...CA }, { ...AL });
}

function task(over: Record<string, unknown>): Record<string, unknown> {
  const row = {
    id: `t-${db.tasks.length + 1}`,
    user_id: "user-1",
    title: "Reply to the notice",
    notes: null,
    status: "todo",
    priority: "medium",
    source: "email",
    external_ref: null,
    external_thread: null,
    due_ts: null,
    agent_instructions: null,
    agent_instructions_at: null,
    agent_done_hash: null,
    ...over,
  };
  db.tasks.push(row);
  return row;
}

// A one-message Gmail thread, and the message lookup that finds its thread.
function gmailThread(threadId: string, body: string) {
  return {
    id: threadId,
    messages: [
      {
        id: "m1",
        threadId,
        internalDate: "1759000000000",
        labelIds: ["INBOX"],
        payload: {
          mimeType: "text/plain",
          headers: [
            { name: "From", value: "Sender <sender@example.test>" },
            { name: "To", value: "ca@example.test" },
            { name: "Subject", value: "Notice" },
          ],
          body: { data: b64(body) },
        },
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// 1. The source email on every task read
// ---------------------------------------------------------------------------
test("task reads serve mail_account and mail_thread_id; an older row resolves once and is written back", async () => {
  seed();
  const stored = task({ id: "t-stored", external_ref: "gmail:ca_tapasnr:m-new", external_thread: "th-new" });
  const older = task({ id: "t-old", external_ref: "gmail:ca_tapasnr:m-old" });
  const icai = task({ id: "t-icai", external_ref: "gmail:icai:m-icai" });
  const manual = task({ id: "t-manual", source: "manual" });
  mail.handler = (url) =>
    url.startsWith(`${GMAIL}/messages/m-old?`)
      ? new Response(JSON.stringify({ threadId: "th-old" }))
      : new Response("{}", { status: 404 });

  const r = (await runReadTool("lifeos_list_tasks", {})) as { items: Record<string, unknown>[] };
  const by = (id: string) => r.items.find((i) => i.id === id)!;
  assert.equal(by("t-stored").mail_account, "ca_tapasnr");
  assert.equal(by("t-stored").mail_thread_id, "th-new");
  assert.equal(by("t-old").mail_account, "ca_tapasnr");
  assert.equal(by("t-old").mail_thread_id, "th-old", "resolved through the provider");
  assert.equal(by("t-icai").mail_account, null, "icai is never served");
  assert.equal(by("t-icai").mail_thread_id, null);
  assert.equal(by("t-manual").mail_account, null);
  assert.equal(older.external_thread, "th-old", "written back to the task");
  assert.equal(stored.external_thread, "th-new");
  assert.equal(icai.external_thread, null);
  assert.equal(manual.external_thread, null);
  assert.deepEqual(mail.calls.length, 1, "one lookup, for the older row only");
  assert.ok(mail.calls[0].includes("fields=threadId") && !mail.calls[0].includes("icai"));

  // Read again: the stored id is used, no second lookup.
  const again = (await runReadTool("lifeos_list_tasks", {})) as { items: Record<string, unknown>[] };
  assert.equal(again.items.find((i) => i.id === "t-old")!.mail_thread_id, "th-old");
  assert.equal(mail.calls.length, 1, "resolved once");
});

test("a Graph task resolves through conversationId, and a provider failure does not fail the list", async () => {
  seed();
  task({ id: "t-graph", external_ref: "graph:altechon:AAMk-1=" });
  mail.handler = (url) =>
    url.startsWith(`${GRAPH}/messages/AAMk-1%3D?`)
      ? new Response(JSON.stringify({ conversationId: "conv-1" }))
      : new Response("{}", { status: 500 });
  const r = (await runReadTool("lifeos_list_tasks", {})) as { items: Record<string, unknown>[] };
  assert.equal(r.items[0].mail_thread_id, "conv-1");
  assert.ok(mail.calls[0].includes("conversationId"));

  seed();
  task({ id: "t-down", external_ref: "gmail:ca_tapasnr:m-x" });
  mail.handler = () => new Response("boom", { status: 500 });
  const down = (await runReadTool("lifeos_list_tasks", {})) as { items: Record<string, unknown>[] };
  assert.equal(down.items[0].mail_account, "ca_tapasnr");
  assert.equal(down.items[0].mail_thread_id, null, "the row still lists");
  assert.equal(db.tasks[0].external_thread, null, "nothing written back");
});

test("lifeos_list_agent_instructions serves the same two fields", async () => {
  seed();
  task({
    id: "t-ins",
    external_ref: "gmail:ca_tapasnr:m-1",
    external_thread: "th-1",
    agent_instructions: "Summarise the notice.",
    agent_instructions_at: "2026-09-30T05:00:00Z",
  });
  task({
    id: "t-ins-old",
    external_ref: "gmail:ca_tapasnr:m-old",
    agent_instructions: "Check the dates.",
    agent_instructions_at: "2026-09-30T06:00:00Z",
  });
  mail.handler = (url) =>
    url.startsWith(`${GMAIL}/messages/m-old?`)
      ? new Response(JSON.stringify({ threadId: "th-old" }))
      : new Response("{}", { status: 404 });
  const r = (await runReadTool("lifeos_list_agent_instructions", {})) as { items: Record<string, unknown>[] };
  assert.equal(r.items.length, 2);
  assert.equal(r.items[0].mail_account, "ca_tapasnr");
  assert.equal(r.items[0].mail_thread_id, "th-1");
  assert.equal(r.items[1].mail_thread_id, "th-old");
  assert.equal(db.tasks[1].external_thread, "th-old");
});

test("parseMessageRef reads the two ref shapes and refuses icai and junk", () => {
  assert.deepEqual(parseMessageRef("gmail:ca_tapasnr:abc:def"), {
    provider: "gmail",
    slot: "ca_tapasnr",
    message_id: "abc:def",
  });
  assert.equal(parseMessageRef("graph:altechon:AAMk")?.provider, "graph");
  assert.equal(parseMessageRef("gmail:icai:abc"), null);
  assert.equal(parseMessageRef("nonsense"), null);
  assert.equal(parseMessageRef(42), null);
});

// ---------------------------------------------------------------------------
// 2. lifeos_read_mail_thread with message_ref
// ---------------------------------------------------------------------------
test("read_mail_thread with message_ref reads the same thread as account plus thread_id", async () => {
  seed();
  mail.handler = (url) => {
    if (url.startsWith(`${GMAIL}/messages/m-old?`)) return new Response(JSON.stringify({ threadId: "th-old" }));
    if (url.startsWith(`${GMAIL}/threads/th-old?`)) return new Response(JSON.stringify(gmailThread("th-old", "Please reply by Friday.")));
    return new Response("{}", { status: 404 });
  };
  const byPair = await runReadTool("lifeos_read_mail_thread", { account: "ca_tapasnr", thread_id: "th-old" });
  const byRef = await runReadTool("lifeos_read_mail_thread", { message_ref: "gmail:ca_tapasnr:m-old" });
  assert.deepEqual(byRef, byPair);
  assert.equal((byRef.messages as { body: string }[])[0].body, "Please reply by Friday.");
  assert.equal(db.audit_log.filter((a) => a.action === "mail_thread_read").length, 2, "both reads audited");
});

test("read_mail_thread refuses both forms, neither form, icai, and a ref for the wrong provider", async () => {
  seed();
  await assert.rejects(
    runReadTool("lifeos_read_mail_thread", { account: "ca_tapasnr", thread_id: "th", message_ref: "gmail:ca_tapasnr:m" }),
    /not both/
  );
  await assert.rejects(runReadTool("lifeos_read_mail_thread", {}), /message_ref/);
  await assert.rejects(runReadTool("lifeos_read_mail_thread", { message_ref: "gmail:icai:m" }), /icai/);
  await assert.rejects(runReadTool("lifeos_read_mail_thread", { message_ref: "junk" }), /message_ref must be/);
  await assert.rejects(runReadTool("lifeos_read_mail_thread", { message_ref: "graph:ca_tapasnr:m" }), /gmail mailbox|graph but/);
  await assert.rejects(runReadTool("lifeos_read_mail_thread", { account: "ca_tapasnr" }), /thread_id/);
  assert.equal(mail.calls.length, 0, "nothing was asked of the provider");
  assert.equal(db.audit_log.length, 0, "nothing was read, nothing audited");
});

test("a message_ref the provider no longer has says so plainly", async () => {
  seed();
  await assert.rejects(runReadTool("lifeos_read_mail_thread", { message_ref: "gmail:ca_tapasnr:gone" }), /No mail message/);
});

// ---------------------------------------------------------------------------
// 3. Mail search
// ---------------------------------------------------------------------------
test("list_inbox with query sends Gmail q (all mail) and Graph $search, and audits no query text", async () => {
  seed();
  mail.handler = (url) =>
    url.startsWith(`${GRAPH}/`) ? new Response(JSON.stringify({ value: [] })) : new Response(JSON.stringify({ messages: [] }));
  await runReadTool("lifeos_list_inbox", { account: "ca_tapasnr", query: "from:board.example agenda" });
  const g = decodeURIComponent(mail.calls[0].replace(/\+/g, " "));
  assert.ok(g.includes("q=from:board.example agenda"), g);
  assert.ok(!g.includes("in:inbox"), "not limited to the inbox");
  assert.ok(!g.includes("after:"), "no default three-day window when searching");

  await runReadTool("lifeos_list_inbox", { account: "ca_tapasnr", query: "agenda", since: "2026-01-01" });
  assert.ok(decodeURIComponent(mail.calls[1]).includes("after:"), "an explicit since still applies");

  await runReadTool("lifeos_list_inbox", { account: "altechon", query: 'board "minutes"' });
  const m = decodeURIComponent(mail.calls[2].replace(/\+/g, " "));
  assert.ok(m.includes("$search=\"board  minutes \""), m);
  assert.ok(m.startsWith(`${GRAPH}/messages?`), "the whole mailbox, not the inbox folder");
  assert.ok(!m.includes("$filter") && !m.includes("$orderby"), "Graph refuses those beside $search");

  await runReadTool("lifeos_list_inbox", { account: "ca_tapasnr" });
  assert.ok(decodeURIComponent(mail.calls[3]).includes("in:inbox"), "no query: the old inbox listing");

  for (const row of db.audit_log) {
    assert.ok(!JSON.stringify(row).includes("agenda"), "the search text is never audited");
  }
});

test("list_inbox refuses a query over 200 characters before asking the provider", async () => {
  seed();
  await assert.rejects(runReadTool("lifeos_list_inbox", { account: "ca_tapasnr", query: "x".repeat(201) }), /at most 200/);
  assert.equal(mail.calls.length, 0);
  mail.handler = () => new Response(JSON.stringify({ messages: [] }));
  await runReadTool("lifeos_list_inbox", { account: "ca_tapasnr", query: "x".repeat(200) });
  assert.equal(mail.calls.length, 1, "exactly 200 is fine");
});

// ---------------------------------------------------------------------------
// 4. Tracked changes and comments in a Word file
// ---------------------------------------------------------------------------
function zip(entries: { name: string; data: Buffer }[]): Uint8Array {
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

const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
const TRACKED_DOC =
  `<w:document ${W}><w:body>` +
  '<w:p><w:r><w:t xml:space="preserve">The fee is </w:t></w:r>' +
  '<w:del w:id="1" w:author="Meera Shah" w:date="2026-09-29T10:00:00Z"><w:r><w:delText xml:space="preserve">Rs 50,000</w:delText></w:r></w:del>' +
  '<w:ins w:id="2" w:author="Meera Shah" w:date="2026-09-29T10:00:00Z"><w:r><w:t>Rs 75,000 &amp; GST</w:t></w:r></w:ins>' +
  '<w:commentRangeStart w:id="0"/><w:r><w:t xml:space="preserve"> payable quarterly.</w:t></w:r><w:commentRangeEnd w:id="0"/>' +
  '<w:r><w:commentReference w:id="0"/></w:r></w:p>' +
  '<w:p><w:pPr><w:rPr><w:ins w:id="3" w:author="Meera Shah"/></w:rPr></w:pPr><w:r><w:t>Second clause.</w:t></w:r></w:p>' +
  "</w:body></w:document>";
const COMMENTS =
  `<w:comments ${W}><w:comment w:id="0" w:author="Ravi Patel" w:date="2026-09-29T11:00:00Z"><w:p><w:r><w:t>Client wants annual billing.</w:t></w:r></w:p></w:comment></w:comments>`;

test("a docx with an insertion, a deletion and a comment reads all three marked, with authors", async () => {
  const bytes = zip([
    { name: "[Content_Types].xml", data: Buffer.from("<Types/>") },
    { name: "word/document.xml", data: Buffer.from(TRACKED_DOC) },
    { name: "word/comments.xml", data: Buffer.from(COMMENTS) },
  ]);
  const r = await docxRead(bytes, 100000);
  assert.equal(r.has_tracked_changes, true);
  assert.ok(r.text.includes("[deleted by Meera Shah: Rs 50,000]"), r.text);
  assert.ok(r.text.includes("[inserted by Meera Shah: Rs 75,000 & GST]"), r.text);
  assert.ok(r.text.includes("[comment 0]"), "the anchor marker");
  assert.ok(r.text.includes("[comment by Ravi Patel: Client wants annual billing.]"), r.text);
  assert.ok(r.text.indexOf("Second clause.") < r.text.indexOf("Comments:"), "comments come last");
  assert.equal(await docxText(bytes, 100000), r.text, "docxText is the same text");
});

test("a docx with no changes reads clean and says so", async () => {
  const doc = `<w:document ${W}><w:body><w:p><w:r><w:t>Plain clause.</w:t></w:r></w:p></w:body></w:document>`;
  const bytes = zip([{ name: "word/document.xml", data: Buffer.from(doc) }]);
  const r = await docxRead(bytes, 1000);
  assert.deepEqual(r, { text: "Plain clause.", has_tracked_changes: false });
  assert.deepEqual(await docxRead(new Uint8Array(10), 1000), { text: "", has_tracked_changes: false });
});

// ---------------------------------------------------------------------------
// 5. Long attachments in parts
// ---------------------------------------------------------------------------
const ACC: MailAccount = { id: "acc-ca", slot: "ca_tapasnr", provider: "google", email: "ca@example.test" };
const LONG = Array.from({ length: 30000 }, (_, i) => String.fromCharCode(97 + (i % 26))).join("");
const attachmentRequest: MailRequest = async (url) => {
  if (/\/attachments\/a1$/.test(url)) return new Response(JSON.stringify({ data: b64("stand-in bytes") }));
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
                { filename: "Agreement.docx", mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", body: { size: 14, attachmentId: "a1" } },
              ],
            },
          },
        ],
      })
    );
  }
  return new Response("{}", { status: 404 });
};
const LONG_EXTRACT = {
  pdf: async () => "",
  docx: async (_b: Uint8Array, cap: number) => ({ text: LONG.slice(0, cap), has_tracked_changes: true }),
};

test("a long attachment read in two calls returns the whole text with the right offsets", async () => {
  const first = await readMailAttachment(attachmentRequest, ACC, { thread_id: "th1", attachment: "Agreement.docx" }, LONG_EXTRACT);
  assert.equal(first.total_chars, 30000);
  assert.equal(first.offset, 0);
  assert.equal(first.chars, ATTACHMENT_TEXT_CAP);
  assert.equal(first.next_offset, ATTACHMENT_TEXT_CAP);
  assert.equal(first.truncated, true);
  assert.equal(first.has_tracked_changes, true);
  assert.ok(first.text.includes(LONG.slice(0, ATTACHMENT_TEXT_CAP)));

  const second = await readMailAttachment(
    attachmentRequest,
    ACC,
    { thread_id: "th1", attachment: "Agreement.docx", offset: first.next_offset },
    LONG_EXTRACT
  );
  assert.equal(second.offset, 20000);
  assert.equal(second.chars, 10000);
  assert.equal(second.total_chars, 30000);
  assert.equal(second.next_offset, null, "the end");
  assert.equal(second.truncated, false);
  assert.ok(second.text.includes(LONG.slice(20000)));
  assert.equal(first.chars + second.chars, 30000, "the two parts are the whole text");
});

test("offset must be a whole number and inside the text; the audit row records it, never text", async () => {
  const base = { thread_id: "th1", attachment: "Agreement.docx" };
  for (const bad of [-1, 1.5, "20"]) {
    await assert.rejects(readMailAttachment(attachmentRequest, ACC, { ...base, offset: bad }, LONG_EXTRACT), /offset must be/);
  }
  await assert.rejects(readMailAttachment(attachmentRequest, ACC, { ...base, offset: 30000 }, LONG_EXTRACT), /past the end/);

  const rows: AttachmentAuditRow[] = [];
  const read = await readMailAttachmentRecorded(attachmentRequest, ACC, { ...base, offset: 20000 }, LONG_EXTRACT, {
    userId: "u1",
    insert: async (row) => {
      rows.push(row);
      return { error: null };
    },
  });
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0].meta, { account: "ca_tapasnr", thread_id: "th1", attachment_name: "Agreement.docx", offset: 20000 });
  assert.ok(!JSON.stringify(rows[0]).includes(LONG.slice(20000, 20030)), "no text in the audit row");
  assert.deepEqual(Object.keys(attachmentAuditRow("u", ACC, read).meta), ["account", "thread_id", "attachment_name", "offset"]);
});

test("a plain-string extractor still works and reports no tracked changes", async () => {
  const r = await readMailAttachment(attachmentRequest, ACC, { thread_id: "th1", attachment: "Agreement.docx" }, {
    pdf: async () => "",
    docx: async () => "short text",
  });
  assert.equal(r.total_chars, 10);
  assert.equal(r.next_offset, null);
  assert.equal(r.has_tracked_changes, false);
});

// ---------------------------------------------------------------------------
// 6. Schemas and descriptions tell an agent how
// ---------------------------------------------------------------------------
test("schemas: one concrete type per parameter, and the descriptions name the new path", () => {
  const thread = READ_TOOL_SCHEMAS.lifeos_read_mail_thread as { properties: Record<string, { type: string }>; required: string[] };
  assert.equal(thread.properties.message_ref.type, "string");
  assert.deepEqual(thread.required, [], "either form, so neither is schema-required");
  const inbox = READ_TOOL_SCHEMAS.lifeos_list_inbox as { properties: Record<string, { type: string }>; required: string[] };
  assert.equal(inbox.properties.query.type, "string");
  assert.deepEqual(inbox.required, ["account"]);
  const att = READ_TOOL_SCHEMAS.lifeos_read_mail_attachment as { properties: Record<string, { type: string }>; required: string[] };
  assert.equal(att.properties.offset.type, "integer");
  assert.ok(!att.required.includes("offset"));
  for (const s of [thread, inbox, att]) {
    for (const p of Object.values(s.properties)) assert.equal(typeof p.type, "string");
  }
  assert.match(READ_TOOL_DESCRIPTIONS.lifeos_read_mail_thread, /message_ref/);
  assert.match(READ_TOOL_DESCRIPTIONS.lifeos_list_agent_instructions, /mail_account and mail_thread_id/);
  assert.match(READ_TOOL_DESCRIPTIONS.lifeos_list_tasks, /mail_thread_id/);
  assert.match(READ_TOOL_DESCRIPTIONS.lifeos_list_inbox, /query/);
  assert.match(READ_TOOL_DESCRIPTIONS.lifeos_read_mail_attachment, /next_offset/);
});
