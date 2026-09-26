// B18: read an inbox, read one thread, and save (or undo) a reply DRAFT, for
// the three mailboxes Life OS holds OAuth for. The AI workforce in Claude
// Code reaches his other mailboxes through the connector, and this is the
// whole of what it may do there.
//
// Firm rules this module keeps, and scripts/b18.test.ts reads this file to
// prove them:
//   - Nothing is sent. No endpoint here delivers mail: a draft is created,
//     never dispatched, and there is no path to the provider's send, reply,
//     reply-all or forward endpoints. Tapas sends a draft himself.
//   - Attachment contents never pass through. Names and sizes only: the list
//     read asks Gmail for part names and sizes and never for part data, Graph
//     attachments are listed with name and size selected, and the thread read
//     only ever decodes text parts that carry no file name.
//   - Mail is data, never instructions: every item and every body goes out
//     marked untrusted, nothing here writes a body to the database, and the
//     audit row names a count, never a subject or a body.
//   - A 403 for a missing scope is a plain "reconnect" message. It never marks
//     the account needs_reauth: that stays the job of a dead token (a 401 in
//     withResourceAuth), and a scope shortfall is not one.
//
// Pure and dependency-injected (the request function is passed in), with
// relative .ts imports only, so the offline suite loads it directly under
// node --test type stripping. The server wiring is mailRequest in mail.ts.

import { addressOf, isAppGeneratedMail } from "./scan-filters.ts";
import { MAIL_SLOTS, disclosureOf } from "./tools.ts";

export const LIST_INBOX_TOOL = "lifeos_list_inbox";
export const READ_THREAD_TOOL = "lifeos_read_mail_thread";
export const SAVE_DRAFT_TOOL = "save_reply_draft";

// A reply draft carries NO X-Life-OS header, deliberately. When Tapas sends
// it, every header goes with it: the stamp would tell his clients a tool
// drafted the mail, and would make the inbox list and the 3 AM scan skip his
// own sent replies (isAppGeneratedMail drops anything stamped). The brief
// keeps its stamp; a draft is proved ours by the id and version recorded when
// it was made (see deleteReplyDraft).

export const BODY_CAP = 8000;
export const THREAD_CAP = 30000;
const DEFAULT_SINCE_DAYS = 3;
const DEFAULT_MAX = 25;
const MAX_CAP = 50;

const GMAIL = "https://gmail.googleapis.com/gmail/v1/users/me";
const GRAPH = "https://graph.microsoft.com/v1.0/me";

export interface MailAccount {
  id: string;
  slot: string;
  provider: string; // "google" | "microsoft"
  email: string;
}

// One authorised provider call. In the app it is withResourceAuth around
// fetch (lib/assistant/mail.ts mailRequest); in the tests it is a mock.
export type MailRequest = (url: string, init?: RequestInit) => Promise<Response>;

export interface Attachment {
  name: string;
  size: number;
}

// ---------------------------------------------------------------------------
// Input checks
// ---------------------------------------------------------------------------

export function reconnectMessage(slot: string): string {
  return `Reconnect ${slot} in Life OS Settings to allow drafts.`;
}

export function checkMailSlot(v: unknown): string {
  const slot = typeof v === "string" ? v.trim() : "";
  if (slot === "icai") {
    throw new Error("The icai mailbox is not open to these mail tools.");
  }
  if (!MAIL_SLOTS.includes(slot)) {
    throw new Error(`account must be one of ${MAIL_SLOTS.join(", ")}.`);
  }
  return slot;
}

function requireThreadId(v: unknown): string {
  const id = typeof v === "string" ? v.trim() : "";
  if (!id) {
    throw new Error(
      "thread_id is required: take it from lifeos_list_inbox. Replies only, never a new thread."
    );
  }
  return id;
}

export interface ReplyDraftInput {
  slot: string;
  thread_id: string;
  body: string;
  reply_all: boolean;
}

const DRAFT_KEYS = new Set(["account", "thread_id", "body", "reply_all"]);

// The schema is closed, and so is the executor: recipients, a subject, a
// cc list or an attachment are refused by name rather than ignored, because a
// model that tried to pass one should hear that it cannot.
export function checkReplyDraftInput(input: Record<string, unknown>): ReplyDraftInput {
  for (const key of Object.keys(input)) {
    if (!DRAFT_KEYS.has(key)) {
      throw new Error(
        `save_reply_draft does not take "${key}". Recipients and the subject come from the thread, and attachments are never added.`
      );
    }
  }
  const slot = checkMailSlot(input.account);
  const thread_id = requireThreadId(input.thread_id);
  const body = typeof input.body === "string" ? input.body : "";
  if (!body.trim()) throw new Error("A reply body is required.");
  if (input.reply_all !== undefined && input.reply_all !== null && typeof input.reply_all !== "boolean") {
    throw new Error("reply_all must be true or false.");
  }
  return { slot, thread_id, body, reply_all: input.reply_all === true };
}

// What the assistant_actions row keeps of a draft call: everything but the
// words. The draft itself lives in the mailbox, and a reply written from a
// client's mail is not something the app database needs a second copy of.
export function storedDraftPayload(input: Record<string, unknown>): Record<string, unknown> {
  const { body, ...rest } = input;
  return { ...rest, body_chars: typeof body === "string" ? body.length : 0 };
}

export function sinceDate(v: unknown, now: Date = new Date()): Date {
  if (v === undefined || v === null || v === "") {
    return new Date(now.getTime() - DEFAULT_SINCE_DAYS * 86400000);
  }
  const raw = typeof v === "string" ? v.trim() : "";
  // A bare date is an IST calendar date, the app's convention everywhere.
  const d = /^\d{4}-\d{2}-\d{2}$/.test(raw) ? new Date(`${raw}T00:00:00+05:30`) : new Date(raw);
  if (!raw || Number.isNaN(d.getTime())) {
    throw new Error("since must be an ISO date such as 2026-09-24.");
  }
  return d;
}

export function clampMax(v: unknown): number {
  const n = Number(v);
  if (v === undefined || v === null || !Number.isFinite(n)) return DEFAULT_MAX;
  return Math.min(Math.max(Math.trunc(n), 1), MAX_CAP);
}

// ---------------------------------------------------------------------------
// Provider errors
// ---------------------------------------------------------------------------

// Gmail answers a missing scope with 403 "insufficient authentication scopes"
// (reason insufficientPermissions / ACCESS_TOKEN_SCOPE_INSUFFICIENT); Graph
// with 403 ErrorAccessDenied. A Gmail 403 for a rate limit is NOT a scope
// problem, so the body decides, not the status alone.
export async function isScopeShortfall(res: Response): Promise<boolean> {
  if (res.status !== 403) return false;
  if (/insufficient_scope/i.test(res.headers.get("www-authenticate") ?? "")) return true;
  const text = await res.text().catch(() => "");
  return /insufficient authentication scopes|insufficientPermissions|ACCESS_TOKEN_SCOPE_INSUFFICIENT|ErrorAccessDenied|Access is denied/i.test(
    text
  );
}

async function ensureOk(res: Response, slot: string, what: string): Promise<void> {
  if (res.ok) return;
  if (await isScopeShortfall(res)) throw new Error(reconnectMessage(slot));
  throw new Error(`${what} failed in ${slot} (${res.status}).`);
}

function notFound(slot: string, threadId: string): Error {
  return new Error(`No mail thread ${threadId} in ${slot}. Take the id from lifeos_list_inbox.`);
}

// ---------------------------------------------------------------------------
// Text helpers (pure)
// ---------------------------------------------------------------------------

const ENTITIES: Record<string, string> = {
  nbsp: " ",
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
};

function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, code: string) => {
    if (code[0] === "#") {
      const n = code[1] === "x" || code[1] === "X" ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : whole;
    }
    return ENTITIES[code.toLowerCase()] ?? whole;
  });
}

// HTML mail to readable text. ponytail: regexes, not a parser. Quoted
// history in HTML sits in a blockquote, removed greedily from the first to the
// last, which loses the new text of an interleaved reply; bodies are capped
// anyway, so a parser is worth it only if interleaved replies start to matter.
export function htmlToText(html: string): string {
  const s = html
    .replace(/<(head|style|script|title)\b[\s\S]*?<\/\1>/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<blockquote\b[\s\S]*<\/blockquote>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|tr|h[1-6]|table)>/gi, "\n")
    .replace(/<li\b[^>]*>/gi, "- ")
    .replace(/<[^>]+>/g, "");
  return decodeEntities(s)
    .replace(/[ \t ]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// Drops quoted history from a plain-text body: "> " lines, and everything
// from an attribution line ("On ... wrote:", "-----Original Message-----",
// an Outlook "From: / Sent:" header block) onwards. A forwarded message is
// the content, not history, so after a "Forwarded message" marker nothing is
// cut.
export function trimQuoted(text: string): string {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const kept: string[] = [];
  let forwarded = false;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i].trim();
    if (/forwarded message/i.test(l)) forwarded = true;
    if (!forwarded) {
      const next = (lines[i + 1] ?? "").trim();
      if (/^On\b.*\bwrote:$/.test(l) || (/^On\b/.test(l) && /\bwrote:$/.test(next))) break;
      if (/^-{2,}\s*Original Message\s*-{2,}$/i.test(l)) break;
      if (/^From:\s/.test(l) && lines.slice(i + 1, i + 5).some((n) => /^(Sent|Date):\s/.test(n.trim()))) break;
    }
    if (l.startsWith(">")) continue;
    kept.push(lines[i]);
  }
  return kept
    .join("\n")
    .replace(/\n\s*_{5,}\s*$/, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// Caps each body at `per` characters and the whole thread at `total`. The
// budget is spent newest first: the latest message is the one being answered.
export function capBodies(
  bodies: string[],
  per: number = BODY_CAP,
  total: number = THREAD_CAP
): { body: string; truncated: boolean }[] {
  let left = total;
  const out: { body: string; truncated: boolean }[] = new Array(bodies.length);
  for (let i = bodies.length - 1; i >= 0; i--) {
    const body = bodies[i].slice(0, Math.max(0, Math.min(per, left)));
    out[i] = { body, truncated: body.length < bodies[i].length };
    left -= body.length;
  }
  return out;
}

// Every address in an address header ("A <a@x>, \"Doe, J\" <j@y>, b@z"),
// lower-cased, first occurrence kept. Commas inside quotes or angle brackets
// do not split.
export function addressesIn(header: string): string[] {
  const out: string[] = [];
  const push = (part: string) => {
    const a = addressOf(part);
    if (/^[^\s@<>",;]+@[^\s@<>",;]+$/.test(a) && !out.includes(a)) out.push(a);
  };
  let buf = "";
  let quoted = false;
  let angled = false;
  for (const ch of header) {
    if (ch === '"') quoted = !quoted;
    else if (!quoted && ch === "<") angled = true;
    else if (!quoted && ch === ">") angled = false;
    if ((ch === "," || ch === ";") && !quoted && !angled) {
      push(buf);
      buf = "";
    } else {
      buf += ch;
    }
  }
  push(buf);
  return out;
}

export interface LastMessage {
  from: string[];
  to: string[];
  cc: string[];
}

// Who a reply goes to, derived here and never taken from the caller. Reply:
// the last message's sender. Reply all: that sender plus its To and Cc. His
// own address is always removed. When he sent the last message himself, the
// reply goes to the people he wrote to (what Gmail and Outlook do), because
// a reply to himself would reach nobody.
export function deriveReplyRecipients(
  last: LastMessage,
  ownAddress: string,
  replyAll: boolean
): { to: string[]; cc: string[] } {
  const me = ownAddress.trim().toLowerCase();
  const sender = (last.from[0] ?? "").toLowerCase();
  const fromSelf = sender === me;
  let to = fromSelf ? [...last.to] : [sender];
  let cc: string[] = [];
  if (replyAll) {
    if (!fromSelf) to.push(...last.to);
    cc = [...last.cc];
  }
  const clean = (list: string[]) =>
    list
      .map((a) => a.toLowerCase())
      .filter((a, i, all) => a && a !== me && all.indexOf(a) === i);
  to = clean(to);
  cc = clean(cc).filter((a) => !to.includes(a));
  if (!to.length && cc.length) {
    to = cc;
    cc = [];
  }
  if (!to.length) {
    throw new Error("This thread has no one to reply to except the mailbox itself.");
  }
  return { to, cc };
}

export function replySubject(subject: string): string {
  const s = subject.replace(/[\r\n]+/g, " ").trim();
  return /^re\s*:/i.test(s) ? s : `Re: ${s}`.trim();
}

function headerValue(v: string): string {
  return v.replace(/[\r\n]+/g, " ").trim();
}

// RFC 2047 for a subject that is not plain ASCII. ponytail: one encoded word,
// no folding; Gmail accepts the long line.
function encodeHeader(v: string): string {
  return /^[\x20-\x7e]*$/.test(v) ? v : `=?UTF-8?B?${Buffer.from(v, "utf8").toString("base64")}?=`;
}

export function buildReplyMime(p: {
  from: string;
  to: string[];
  cc: string[];
  subject: string;
  inReplyTo: string;
  references: string;
  body: string;
}): string {
  const body64 = Buffer.from(p.body.replace(/\r?\n/g, "\r\n"), "utf8")
    .toString("base64")
    .replace(/.{76}/g, "$&\r\n");
  return [
    `From: ${headerValue(p.from)}`,
    `To: ${p.to.map(headerValue).join(", ")}`,
    ...(p.cc.length ? [`Cc: ${p.cc.map(headerValue).join(", ")}`] : []),
    `Subject: ${encodeHeader(headerValue(p.subject))}`,
    ...(p.inReplyTo ? [`In-Reply-To: ${headerValue(p.inReplyTo)}`] : []),
    ...(p.references ? [`References: ${headerValue(p.references)}`] : []),
    "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: base64",
    "",
    body64,
  ].join("\r\n");
}

// ---------------------------------------------------------------------------
// Gmail dialect
// ---------------------------------------------------------------------------

interface GmailHeader {
  name: string;
  value: string;
}

interface GmailPart {
  mimeType?: string;
  filename?: string;
  headers?: GmailHeader[];
  body?: { size?: number; data?: string };
  parts?: GmailPart[];
}

interface GmailMessage {
  id: string;
  threadId: string;
  labelIds?: string[];
  snippet?: string;
  internalDate?: string;
  payload?: GmailPart;
}

function gHeader(part: GmailPart | undefined, name: string): string {
  const n = name.toLowerCase();
  return part?.headers?.find((h) => h.name.toLowerCase() === n)?.value ?? "";
}

function gmailAttachments(part: GmailPart | undefined, out: Attachment[] = []): Attachment[] {
  if (!part) return out;
  if (part.filename) out.push({ name: part.filename, size: part.body?.size ?? 0 });
  for (const child of part.parts ?? []) gmailAttachments(child, out);
  return out;
}

// A text part is a body only when it carries no file name: a part with a name
// is an attachment, and attachment contents are never decoded here.
function findTextPart(part: GmailPart | undefined, mime: string): GmailPart | undefined {
  if (!part) return undefined;
  if (!part.filename && part.mimeType === mime && part.body?.data) return part;
  for (const child of part.parts ?? []) {
    const hit = findTextPart(child, mime);
    if (hit) return hit;
  }
  return undefined;
}

function decodePart(part: GmailPart): string {
  const bytes = Buffer.from(part.body?.data ?? "", "base64url");
  const charset = /charset="?([^";\s]+)"?/i.exec(gHeader(part, "Content-Type"))?.[1] ?? "utf-8";
  try {
    return new TextDecoder(charset).decode(bytes);
  } catch {
    return bytes.toString("utf8");
  }
}

function gmailBody(payload: GmailPart | undefined): string {
  const plain = findTextPart(payload, "text/plain");
  if (plain) return decodePart(plain);
  const html = findTextPart(payload, "text/html");
  return html ? htmlToText(decodePart(html)) : "";
}

function gmailIso(m: GmailMessage): string {
  const ms = Number(m.internalDate);
  return Number.isFinite(ms) && ms > 0 ? new Date(ms).toISOString() : gHeader(m.payload, "Date");
}

// Gmail returns only the fields asked for: part names and sizes, never part
// data, so no body and no attachment content crosses for an inbox listing.
const GMAIL_LIST_FIELDS =
  "id,threadId,labelIds,snippet,internalDate,payload(headers,filename,body/size," +
  "parts(filename,body/size,parts(filename,body/size,parts(filename,body/size))))";

// Oldest first, drafts out: the conversation as it was actually sent.
function sentMessages(messages: GmailMessage[] | undefined): GmailMessage[] {
  return (messages ?? [])
    .filter((m) => !(m.labelIds ?? []).includes("DRAFT"))
    .sort((a, b) => Number(a.internalDate ?? 0) - Number(b.internalDate ?? 0));
}

// ---------------------------------------------------------------------------
// Graph dialect
// ---------------------------------------------------------------------------

interface GraphAddress {
  emailAddress?: { name?: string; address?: string };
}

interface GraphMessage {
  id: string;
  conversationId?: string;
  from?: GraphAddress;
  toRecipients?: GraphAddress[];
  ccRecipients?: GraphAddress[];
  subject?: string;
  receivedDateTime?: string;
  bodyPreview?: string;
  body?: { contentType?: string; content?: string };
  isRead?: boolean;
  isDraft?: boolean;
  hasAttachments?: boolean;
  internetMessageHeaders?: GmailHeader[];
}

function graphDisplay(a: GraphAddress | undefined): string {
  const name = a?.emailAddress?.name ?? "";
  const addr = a?.emailAddress?.address ?? "";
  return name && name !== addr ? `${name} <${addr}>` : addr;
}

function graphList(list: GraphAddress[] | undefined): string {
  return (list ?? []).map(graphDisplay).filter(Boolean).join(", ");
}

function graphAddrs(list: GraphAddress[] | undefined): string[] {
  return (list ?? [])
    .map((a) => (a.emailAddress?.address ?? "").trim().toLowerCase())
    .filter(Boolean);
}

function odataQuote(v: string): string {
  return v.replace(/'/g, "''");
}

async function graphAttachments(request: MailRequest, account: MailAccount, messageId: string): Promise<Attachment[]> {
  const res = await request(
    `${GRAPH}/messages/${encodeURIComponent(messageId)}/attachments?` +
      new URLSearchParams({ $select: "name,size" })
  );
  await ensureOk(res, account.slot, "Listing attachments");
  const j = (await res.json()) as { value?: { name?: string; size?: number }[] };
  return (j.value ?? []).map((a) => ({ name: a.name ?? "", size: a.size ?? 0 }));
}

// The messages of one conversation, oldest first, drafts out. No $orderby:
// Graph refuses one beside a conversationId filter, so the sort is ours.
async function graphConversation(
  request: MailRequest,
  account: MailAccount,
  conversationId: string,
  select: string,
  init?: RequestInit
): Promise<GraphMessage[]> {
  const res = await request(
    `${GRAPH}/messages?` +
      new URLSearchParams({
        $filter: `conversationId eq '${odataQuote(conversationId)}'`,
        $select: select,
        $top: "50",
      }),
    init
  );
  if (res.status === 400 || res.status === 404) throw notFound(account.slot, conversationId);
  await ensureOk(res, account.slot, "Reading the thread");
  const j = (await res.json()) as { value?: GraphMessage[] };
  const msgs = (j.value ?? [])
    .filter((m) => !m.isDraft)
    .sort((a, b) => Date.parse(a.receivedDateTime ?? "") - Date.parse(b.receivedDateTime ?? ""));
  if (!msgs.length) throw notFound(account.slot, conversationId);
  return msgs;
}

// ---------------------------------------------------------------------------
// 1. The inbox
// ---------------------------------------------------------------------------

export interface InboxItem {
  id: string;
  thread_id: string;
  from: string;
  to: string;
  cc: string;
  subject: string;
  date: string;
  snippet: string;
  unread: boolean;
  has_attachments: boolean;
  attachments: Attachment[];
  untrusted: true;
}

export async function listInbox(
  request: MailRequest,
  account: MailAccount,
  input: Record<string, unknown>,
  now: Date = new Date()
): Promise<{ account: string; since: string; count: number; items: InboxItem[] }> {
  const since = sinceDate(input.since, now);
  const max = clampMax(input.max);
  const unreadOnly = input.unread_only === true;
  const items: InboxItem[] = [];

  if (account.provider === "google") {
    const q = `in:inbox after:${Math.floor(since.getTime() / 1000)}` + (unreadOnly ? " is:unread" : "");
    const listRes = await request(
      `${GMAIL}/messages?` + new URLSearchParams({ q, maxResults: String(max) })
    );
    await ensureOk(listRes, account.slot, "Listing the inbox");
    const list = (await listRes.json()) as { messages?: { id: string }[] };
    for (const ref of list.messages ?? []) {
      const res = await request(
        `${GMAIL}/messages/${encodeURIComponent(ref.id)}?` +
          new URLSearchParams({ format: "full", fields: GMAIL_LIST_FIELDS })
      );
      // One unreadable message (gone since the list, a transient error) is
      // skipped, as the scan does; a missing scope stops the whole read.
      if (!res.ok) {
        if (await isScopeShortfall(res)) throw new Error(reconnectMessage(account.slot));
        continue;
      }
      const m = (await res.json()) as GmailMessage;
      const from = gHeader(m.payload, "From");
      const subject = gHeader(m.payload, "Subject");
      if (isAppGeneratedMail({ from, subject, appTag: gHeader(m.payload, "X-Life-OS") }, account.email)) {
        continue;
      }
      const attachments = gmailAttachments(m.payload);
      items.push({
        id: m.id,
        thread_id: m.threadId,
        from,
        to: gHeader(m.payload, "To"),
        cc: gHeader(m.payload, "Cc"),
        subject,
        date: gmailIso(m),
        snippet: decodeEntities(m.snippet ?? ""),
        unread: (m.labelIds ?? []).includes("UNREAD"),
        has_attachments: attachments.length > 0,
        attachments,
        untrusted: true,
      });
    }
  } else {
    const filter =
      `receivedDateTime ge ${since.toISOString()}` + (unreadOnly ? " and isRead eq false" : "");
    const res = await request(
      `${GRAPH}/mailFolders/inbox/messages?` +
        new URLSearchParams({
          $top: String(max),
          $orderby: "receivedDateTime desc",
          $filter: filter,
          $select:
            "id,conversationId,from,toRecipients,ccRecipients,subject,receivedDateTime,bodyPreview,isRead,hasAttachments,internetMessageHeaders",
        })
    );
    await ensureOk(res, account.slot, "Listing the inbox");
    const j = (await res.json()) as { value?: GraphMessage[] };
    for (const m of j.value ?? []) {
      const from = graphDisplay(m.from);
      const subject = m.subject ?? "";
      const appTag =
        (m.internetMessageHeaders ?? []).find((h) => h.name.toLowerCase() === "x-life-os")?.value ?? "";
      if (isAppGeneratedMail({ from, subject, appTag }, account.email)) continue;
      const attachments = m.hasAttachments ? await graphAttachments(request, account, m.id) : [];
      items.push({
        id: m.id,
        thread_id: m.conversationId ?? "",
        from,
        to: graphList(m.toRecipients),
        cc: graphList(m.ccRecipients),
        subject,
        date: m.receivedDateTime ?? "",
        snippet: m.bodyPreview ?? "",
        unread: m.isRead === false,
        has_attachments: !!m.hasAttachments,
        attachments,
        untrusted: true,
      });
    }
  }
  return { account: account.slot, since: since.toISOString(), count: items.length, items };
}

// ---------------------------------------------------------------------------
// 2. One thread
// ---------------------------------------------------------------------------

export interface ThreadMessage {
  id: string;
  from: string;
  to: string;
  cc: string;
  date: string;
  subject: string;
  body: string;
  body_truncated: boolean;
  attachments: Attachment[];
  untrusted: true;
}

export async function readThread(
  request: MailRequest,
  account: MailAccount,
  threadIdRaw: unknown
): Promise<{ account: string; thread_id: string; message_count: number; messages: ThreadMessage[] }> {
  const threadId = requireThreadId(threadIdRaw);
  const raw: Omit<ThreadMessage, "body" | "body_truncated">[] = [];
  const bodies: string[] = [];

  if (account.provider === "google") {
    const res = await request(
      `${GMAIL}/threads/${encodeURIComponent(threadId)}?` + new URLSearchParams({ format: "full" })
    );
    if (res.status === 400 || res.status === 404) throw notFound(account.slot, threadId);
    await ensureOk(res, account.slot, "Reading the thread");
    const t = (await res.json()) as { messages?: GmailMessage[] };
    const msgs = sentMessages(t.messages);
    if (!msgs.length) throw notFound(account.slot, threadId);
    for (const m of msgs) {
      raw.push({
        id: m.id,
        from: gHeader(m.payload, "From"),
        to: gHeader(m.payload, "To"),
        cc: gHeader(m.payload, "Cc"),
        date: gmailIso(m),
        subject: gHeader(m.payload, "Subject"),
        attachments: gmailAttachments(m.payload),
        untrusted: true,
      });
      bodies.push(trimQuoted(gmailBody(m.payload)));
    }
  } else {
    // Graph converts HTML to text itself when asked; htmlToText stays as the
    // belt for a server that ignores the preference.
    const msgs = await graphConversation(
      request,
      account,
      threadId,
      "id,from,toRecipients,ccRecipients,subject,receivedDateTime,body,hasAttachments,isDraft",
      { headers: { prefer: 'outlook.body-content-type="text"' } }
    );
    for (const m of msgs) {
      raw.push({
        id: m.id,
        from: graphDisplay(m.from),
        to: graphList(m.toRecipients),
        cc: graphList(m.ccRecipients),
        date: m.receivedDateTime ?? "",
        subject: m.subject ?? "",
        attachments: m.hasAttachments ? await graphAttachments(request, account, m.id) : [],
        untrusted: true,
      });
      const content = m.body?.content ?? "";
      bodies.push(trimQuoted(m.body?.contentType?.toLowerCase() === "html" ? htmlToText(content) : content));
    }
  }

  const capped = capBodies(bodies);
  const messages = raw.map((m, i) => ({
    ...m,
    body: capped[i].body,
    body_truncated: capped[i].truncated,
  }));
  return { account: account.slot, thread_id: threadId, message_count: messages.length, messages };
}

// B10 for save_reply_draft: the thread has to be there before the autonomous
// grant applies. False only when the provider says there is no such thread.
export async function threadExists(
  request: MailRequest,
  account: MailAccount,
  threadId: string
): Promise<boolean> {
  if (account.provider === "google") {
    const res = await request(
      `${GMAIL}/threads/${encodeURIComponent(threadId)}?` + new URLSearchParams({ format: "minimal" })
    );
    if (res.status === 400 || res.status === 404) return false;
    await ensureOk(res, account.slot, "Looking up the thread");
    return true;
  }
  try {
    await graphConversation(request, account, threadId, "id,isDraft");
    return true;
  } catch (e) {
    if (e instanceof Error && e.message.startsWith("No mail thread")) return false;
    throw e;
  }
}

// ---------------------------------------------------------------------------
// The audit row a mail read leaves behind (B15 pattern: checked, and written
// before anything is handed over). A count, never a subject or a body.
// ---------------------------------------------------------------------------

export interface MailReadAudit {
  userId: string;
  origin: string;
  insert: (row: MailReadAuditRow) => PromiseLike<{ error: { message: string } | null }>;
}

export interface MailReadAuditRow {
  user_id: string;
  actor: "assistant";
  action: string;
  entity: string;
  entity_id: string;
  meta: {
    tool: string;
    disclosure: string;
    actor_origin: string;
    message_count: number;
    reason: string;
  };
}

export function mailReadAuditRow(
  tool: string,
  account: MailAccount,
  audit: Pick<MailReadAudit, "userId" | "origin">,
  messageCount: number
): MailReadAuditRow {
  return {
    user_id: audit.userId,
    actor: "assistant",
    action: tool === READ_THREAD_TOOL ? "mail_thread_read" : "mail_inbox_read",
    entity: account.slot,
    entity_id: account.id,
    meta: {
      tool,
      disclosure: disclosureOf(tool),
      actor_origin: audit.origin,
      message_count: messageCount,
      reason: `mail read over the connector, disclosure ${disclosureOf(tool)}`,
    },
  };
}

async function handOver<T>(
  tool: string,
  account: MailAccount,
  audit: MailReadAudit,
  result: T,
  count: number
): Promise<T> {
  const { error } = await audit.insert(mailReadAuditRow(tool, account, audit, count));
  if (error) {
    throw new Error(
      `The mail was not handed over: the read could not be recorded (${error.message}).`
    );
  }
  return result;
}

export async function listInboxRecorded(
  request: MailRequest,
  account: MailAccount,
  input: Record<string, unknown>,
  audit: MailReadAudit
): Promise<Awaited<ReturnType<typeof listInbox>>> {
  const r = await listInbox(request, account, input);
  return handOver(LIST_INBOX_TOOL, account, audit, r, r.count);
}

export async function readThreadRecorded(
  request: MailRequest,
  account: MailAccount,
  threadId: unknown,
  audit: MailReadAudit
): Promise<Awaited<ReturnType<typeof readThread>>> {
  const r = await readThread(request, account, threadId);
  return handOver(READ_THREAD_TOOL, account, audit, r, r.message_count);
}

// ---------------------------------------------------------------------------
// 3. The reply draft, and its undo
// ---------------------------------------------------------------------------

export interface ReplyDraftResult {
  draft_id: string;
  // What the draft looked like when Life OS left it: the Gmail message id (a
  // new one is minted each time the draft is edited) or Graph's
  // lastModifiedDateTime. Undo refuses a draft that has moved on from it, so
  // an undo never throws away words Tapas added himself.
  version: string;
  to: string[];
  cc: string[];
  subject: string;
}

export async function saveReplyDraft(
  request: MailRequest,
  account: MailAccount,
  draft: ReplyDraftInput
): Promise<ReplyDraftResult> {
  if (account.provider === "google") {
    const res = await request(
      `${GMAIL}/threads/${encodeURIComponent(draft.thread_id)}?` +
        new URLSearchParams({ format: "metadata" }) +
        ["From", "To", "Cc", "Subject", "Message-ID", "References"]
          .map((h) => `&metadataHeaders=${h}`)
          .join("")
    );
    if (res.status === 400 || res.status === 404) throw notFound(account.slot, draft.thread_id);
    await ensureOk(res, account.slot, "Reading the thread");
    const t = (await res.json()) as { messages?: GmailMessage[] };
    const msgs = sentMessages(t.messages);
    const last = msgs[msgs.length - 1];
    if (!last) throw notFound(account.slot, draft.thread_id);
    const p = last.payload;
    const rec = deriveReplyRecipients(
      {
        from: addressesIn(gHeader(p, "From")),
        to: addressesIn(gHeader(p, "To")),
        cc: addressesIn(gHeader(p, "Cc")),
      },
      account.email,
      draft.reply_all
    );
    const subject = replySubject(gHeader(p, "Subject"));
    const messageId = gHeader(p, "Message-ID");
    const mime = buildReplyMime({
      from: account.email,
      ...rec,
      subject,
      inReplyTo: messageId,
      references: `${gHeader(p, "References")} ${messageId}`.trim(),
      body: draft.body,
    });
    const created = await request(`${GMAIL}/drafts`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        message: { raw: Buffer.from(mime, "utf8").toString("base64url"), threadId: draft.thread_id },
      }),
    });
    await ensureOk(created, account.slot, "Saving the draft");
    const d = (await created.json()) as { id: string; message?: { id?: string } };
    return { draft_id: d.id, version: d.message?.id ?? "", ...rec, subject };
  }

  // Graph: createReply or createReplyAll makes the draft in Drafts and
  // threads it; the PATCH then sets our body and our derived recipients.
  const msgs = await graphConversation(
    request,
    account,
    draft.thread_id,
    "id,from,toRecipients,ccRecipients,subject,receivedDateTime,isDraft"
  );
  const last = msgs[msgs.length - 1];
  const rec = deriveReplyRecipients(
    {
      from: graphAddrs(last.from ? [last.from] : []),
      to: graphAddrs(last.toRecipients),
      cc: graphAddrs(last.ccRecipients),
    },
    account.email,
    draft.reply_all
  );
  const verb = draft.reply_all ? "createReplyAll" : "createReply";
  const created = await request(`${GRAPH}/messages/${encodeURIComponent(last.id)}/${verb}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  await ensureOk(created, account.slot, "Saving the draft");
  const shell = (await created.json()) as { id: string; subject?: string };
  const draftUrl = `${GRAPH}/messages/${encodeURIComponent(shell.id)}`;
  const patched = await request(draftUrl, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      body: { contentType: "Text", content: draft.body },
      toRecipients: rec.to.map((address) => ({ emailAddress: { address } })),
      ccRecipients: rec.cc.map((address) => ({ emailAddress: { address } })),
    }),
  });
  if (!patched.ok) {
    // The empty shell is ours and seconds old: remove it rather than leave a
    // blank draft behind, then report why.
    await request(draftUrl, { method: "DELETE" }).catch(() => undefined);
    await ensureOk(patched, account.slot, "Writing the draft");
  }
  const d = (await patched.json()) as { lastModifiedDateTime?: string; subject?: string };
  return {
    draft_id: shell.id,
    version: d.lastModifiedDateTime ?? "",
    ...rec,
    subject: d.subject ?? shell.subject ?? replySubject(last.subject ?? ""),
  };
}

// Undo: delete ONLY a draft this tool created, the way delete_event removes
// only an app-created event. Proof of ownership is the record, not a header:
// the draft id and version come from the executed action's own row (written
// when the draft was made, and in the audit row beside it), never from the
// caller. The provider is then asked, and the draft must still be exactly as
// Life OS left it: for Gmail the same message id (a sent draft is gone, and
// an edited one has a new message id), for Graph still a draft with the same
// lastModifiedDateTime. Anything else is refused and left where it is.
export async function deleteReplyDraft(
  request: MailRequest,
  account: MailAccount,
  undo: { draft_id: string; version: string }
): Promise<void> {
  const gone = new Error(
    "That draft is no longer in the mailbox (it may have been sent or deleted), so there is nothing to undo."
  );
  const edited = new Error(
    "That draft has been edited since Life OS saved it, so it was left alone. Delete it in the mailbox if it is not wanted."
  );
  if (!undo.draft_id.trim()) throw gone;
  // Without the recorded version there is nothing to prove the draft is
  // untouched, so nothing is deleted.
  if (!undo.version.trim()) {
    throw new Error("Life OS has no record of how it left that draft, so it will not be deleted.");
  }
  if (account.provider === "google") {
    const url = `${GMAIL}/drafts/${encodeURIComponent(undo.draft_id)}`;
    const res = await request(`${url}?` + new URLSearchParams({ format: "minimal" }));
    if (res.status === 400 || res.status === 404) throw gone;
    await ensureOk(res, account.slot, "Looking up the draft");
    const d = (await res.json()) as { id?: string; message?: { id?: string } };
    if (d.message?.id !== undo.version) throw edited;
    const del = await request(url, { method: "DELETE" });
    await ensureOk(del, account.slot, "Deleting the draft");
    return;
  }
  const url = `${GRAPH}/messages/${encodeURIComponent(undo.draft_id)}`;
  const res = await request(`${url}?` + new URLSearchParams({ $select: "id,isDraft,lastModifiedDateTime" }));
  if (res.status === 400 || res.status === 404) throw gone;
  await ensureOk(res, account.slot, "Looking up the draft");
  const m = (await res.json()) as { isDraft?: boolean; lastModifiedDateTime?: string };
  if (m.isDraft !== true) {
    throw new Error("That message is not a draft, so it will not be deleted.");
  }
  if (m.lastModifiedDateTime !== undo.version) throw edited;
  const del = await request(url, { method: "DELETE" });
  await ensureOk(del, account.slot, "Deleting the draft");
}
