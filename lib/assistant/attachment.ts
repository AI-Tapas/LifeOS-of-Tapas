// B22. The text of ONE named mail attachment, on request only.
//
// Tapas approved this on 28 September 2026: "any attachment, one at a time,
// only when Tapas or his agent asks for that named attachment". So:
//   - Only lifeos_read_mail_attachment reaches this, an explicit read tool
//     naming the account, the thread and the attachment. The nightly scan
//     never does: its rules are unchanged (ticket and cab-receipt senders
//     only, through readTicketMail), and scripts/b22.test.ts fails if
//     scan.ts ever names this module.
//   - The three connected mailboxes only. checkMailSlot refuses icai.
//   - PDF (unpdf, the B20 reader) and Word .docx (docx-text.ts, Node's own
//     zlib) only. At most ATTACHMENT_MAX_BYTES, refused before download when
//     the provider states the size and again on the real length. At most
//     ATTACHMENT_TEXT_CAP characters come back per call. One attachment per
//     call. B27: a longer file is read in parts with `offset`; the reply says
//     total_chars and next_offset (null at the end).
//   - The text is untrusted data and goes out inside the fence.
//   - The audit row names the account, the thread id and the attachment name,
//     (and, since B27, the offset), never a byte of the text. It is written before the text is handed over,
//     and if it cannot be written nothing is handed over (the B15 pattern).
//   - Nothing is stored anywhere else.
//
// Pure and dependency-injected like mailbox.ts (the request and the two text
// extractors are passed in), so the offline suite drives it with mocks.

import {
  checkMailSlot,
  ensureOk,
  graphConversation,
  notFound,
  requireThreadId,
  sentMessages,
  type GmailMessage,
  type GmailPart,
  type MailAccount,
  type MailRequest,
} from "./mailbox.ts";
import { fenceUntrusted } from "./prompt.ts";

export const READ_ATTACHMENT_TOOL = "lifeos_read_mail_attachment";
export const ATTACHMENT_MAX_BYTES = 5 * 1024 * 1024;
export const ATTACHMENT_TEXT_CAP = 20000;
// B27: the most text read out of one file in all, whatever the offset.
export const ATTACHMENT_TOTAL_CAP = 400000;

const GMAIL = "https://gmail.googleapis.com/gmail/v1/users/me";
const GRAPH = "https://graph.microsoft.com/v1.0/me";

const PDF_MIME = "application/pdf";
const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

export type TextFn = (bytes: Uint8Array, cap: number) => Promise<string>;
// The Word reader may also say whether the file carries tracked changes.
export type DocxFn = (
  bytes: Uint8Array,
  cap: number
) => Promise<string | { text: string; has_tracked_changes: boolean }>;
export interface Extractors {
  pdf: TextFn;
  docx: DocxFn;
}

export function checkOffset(v: unknown): number {
  if (v === undefined || v === null) return 0;
  if (typeof v !== "number" || !Number.isInteger(v) || v < 0) {
    throw new Error("offset must be a whole number, 0 or more (the next_offset of the previous call).");
  }
  return v;
}

interface Candidate {
  name: string;
  id: string;
  size: number;
  mime: string;
  fetchBytes: () => Promise<Uint8Array>;
}

export function attachmentKind(name: string, mime: string): "pdf" | "docx" | null {
  const m = mime.toLowerCase();
  const n = name.toLowerCase();
  if (m === PDF_MIME || n.endsWith(".pdf")) return "pdf";
  if (m === DOCX_MIME || n.endsWith(".docx")) return "docx";
  return null;
}

function gmailFileParts(part: GmailPart | undefined, out: GmailPart[] = []): GmailPart[] {
  if (!part) return out;
  if (part.filename && part.body?.attachmentId) out.push(part);
  for (const child of part.parts ?? []) gmailFileParts(child, out);
  return out;
}

// Every file attached anywhere in the thread, newest message first, so a
// name that recurs (a revised draft sent twice) resolves to the latest copy.
async function threadAttachments(
  request: MailRequest,
  account: MailAccount,
  threadId: string
): Promise<Candidate[]> {
  const out: Candidate[] = [];
  if (account.provider === "google") {
    const res = await request(
      `${GMAIL}/threads/${encodeURIComponent(threadId)}?` + new URLSearchParams({ format: "full" })
    );
    if (res.status === 400 || res.status === 404) throw notFound(account.slot, threadId);
    await ensureOk(res, account.slot, "Reading the thread");
    const t = (await res.json()) as { messages?: GmailMessage[] };
    const msgs = sentMessages(t.messages).reverse();
    if (!msgs.length) throw notFound(account.slot, threadId);
    for (const m of msgs) {
      for (const p of gmailFileParts(m.payload)) {
        const attId = p.body!.attachmentId!;
        out.push({
          name: p.filename ?? "",
          id: attId,
          size: p.body?.size ?? 0,
          mime: p.mimeType ?? "",
          fetchBytes: async () => {
            const r = await request(
              `${GMAIL}/messages/${encodeURIComponent(m.id)}/attachments/${encodeURIComponent(attId)}`
            );
            await ensureOk(r, account.slot, "Reading the attachment");
            const j = (await r.json()) as { data?: string };
            return new Uint8Array(Buffer.from(j.data ?? "", "base64url"));
          },
        });
      }
    }
    return out;
  }
  const msgs = (
    await graphConversation(request, account, threadId, "id,receivedDateTime,hasAttachments,isDraft")
  ).reverse();
  for (const m of msgs) {
    if (!m.hasAttachments) continue;
    const list = await request(
      `${GRAPH}/messages/${encodeURIComponent(m.id)}/attachments?` +
        new URLSearchParams({ $select: "id,name,contentType,size" })
    );
    await ensureOk(list, account.slot, "Listing attachments");
    const j = (await list.json()) as {
      value?: { id: string; name?: string; contentType?: string; size?: number }[];
    };
    for (const a of j.value ?? []) {
      out.push({
        name: a.name ?? "",
        id: a.id,
        size: a.size ?? 0,
        mime: a.contentType ?? "",
        fetchBytes: async () => {
          const r = await request(
            `${GRAPH}/messages/${encodeURIComponent(m.id)}/attachments/${encodeURIComponent(a.id)}/$value`
          );
          await ensureOk(r, account.slot, "Reading the attachment");
          return new Uint8Array(await r.arrayBuffer());
        },
      });
    }
  }
  return out;
}

function tooBig(name: string): Error {
  return new Error(
    `${name} is larger than 5 MB, so it is not read. Open it in the mailbox instead.`
  );
}

export interface AttachmentText {
  account: string;
  thread_id: string;
  attachment_name: string;
  kind: "pdf" | "docx";
  size: number;
  offset: number;
  chars: number;
  total_chars: number;
  next_offset: number | null;
  // True when the file has more text than one file is read for at all.
  beyond_read_limit: boolean;
  truncated: boolean;
  has_tracked_changes: boolean;
  text: string;
  untrusted: true;
}

export async function readMailAttachment(
  request: MailRequest,
  account: MailAccount,
  input: Record<string, unknown>,
  extract: Extractors
): Promise<AttachmentText> {
  checkMailSlot(account.slot);
  const threadId = requireThreadId(input.thread_id);
  const offset = checkOffset(input.offset);
  const wanted = typeof input.attachment === "string" ? input.attachment.trim() : "";
  if (!wanted) {
    throw new Error(
      "attachment is required: the file name exactly as lifeos_read_mail_thread lists it."
    );
  }
  const all = await threadAttachments(request, account, threadId);
  const hit =
    all.find((a) => a.id === wanted) ??
    all.find((a) => a.name.toLowerCase() === wanted.toLowerCase());
  if (!hit) {
    const names = [...new Set(all.map((a) => a.name).filter(Boolean))];
    throw new Error(
      `No attachment called "${wanted}" in that thread. ${
        names.length ? `Its attachments: ${names.join(", ")}.` : "It has no attachments."
      }`
    );
  }
  const kind = attachmentKind(hit.name, hit.mime);
  if (!kind) {
    throw new Error(`${hit.name} is not a PDF or a Word (.docx) file, so it cannot be read as text.`);
  }
  if (hit.size > ATTACHMENT_MAX_BYTES) throw tooBig(hit.name);
  const bytes = await hit.fetchBytes();
  if (bytes.length > ATTACHMENT_MAX_BYTES) throw tooBig(hit.name);
  const got = await extract[kind](bytes, ATTACHMENT_TOTAL_CAP + 1);
  const whole = typeof got === "string" ? { text: got, has_tracked_changes: false } : got;
  const raw = whole.text.trim();
  const beyond = raw.length > ATTACHMENT_TOTAL_CAP;
  const whole_text = raw.slice(0, ATTACHMENT_TOTAL_CAP);
  if (offset > 0 && offset >= whole_text.length) {
    throw new Error(`offset ${offset} is past the end: the text is ${whole_text.length} characters.`);
  }
  const text = whole_text.slice(offset, offset + ATTACHMENT_TEXT_CAP);
  const next = offset + text.length < whole_text.length ? offset + text.length : null;
  return {
    account: account.slot,
    thread_id: threadId,
    attachment_name: hit.name,
    kind,
    size: bytes.length,
    offset,
    chars: text.length,
    total_chars: whole_text.length,
    next_offset: next,
    beyond_read_limit: beyond,
    truncated: next !== null,
    has_tracked_changes: whole.has_tracked_changes,
    text: fenceUntrusted(
      `text of the attachment ${hit.name} in the ${account.slot} mailbox${offset ? ` from character ${offset}` : ""}`,
      text || "(No text could be read. It may be a scanned image, which is not read.)"
    ),
    untrusted: true,
  };
}

// ---------------------------------------------------------------------------
// The audit row: account, thread id and attachment name. Never the text.
// ---------------------------------------------------------------------------

export interface AttachmentAuditRow {
  user_id: string;
  actor: "assistant";
  action: "mail_attachment_read";
  entity: string;
  entity_id: string;
  meta: { account: string; thread_id: string; attachment_name: string; offset: number };
}

export function attachmentAuditRow(
  userId: string,
  account: MailAccount,
  read: Pick<AttachmentText, "thread_id" | "attachment_name" | "offset">
): AttachmentAuditRow {
  return {
    user_id: userId,
    actor: "assistant",
    action: "mail_attachment_read",
    entity: account.slot,
    entity_id: account.id,
    meta: {
      account: account.slot,
      thread_id: read.thread_id,
      attachment_name: read.attachment_name,
      offset: read.offset,
    },
  };
}

export async function readMailAttachmentRecorded(
  request: MailRequest,
  account: MailAccount,
  input: Record<string, unknown>,
  extract: Extractors,
  audit: {
    userId: string;
    insert: (row: AttachmentAuditRow) => PromiseLike<{ error: { message: string } | null }>;
  }
): Promise<AttachmentText> {
  const read = await readMailAttachment(request, account, input, extract);
  const { error } = await audit.insert(attachmentAuditRow(audit.userId, account, read));
  if (error) {
    throw new Error(
      `The attachment was not handed over: the read could not be recorded (${error.message}).`
    );
  }
  return read;
}
