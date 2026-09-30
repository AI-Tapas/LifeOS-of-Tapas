// B27. Find the email behind a task.
//
// A task made from mail stores external_ref ("gmail:<slot>:<message id>" or
// "graph:<slot>:<message id>") and, since B20, external_thread. The mail
// tools need an account and a thread id, so the task reads serve both, and
// lifeos_read_mail_thread also takes the external_ref as `message_ref`.
//
// Pure and dependency-injected like mailbox.ts (relative .ts imports only), so
// the offline suite drives it with mocks. Only ids move here: no subject, no
// sender, no body. The icai slot is never resolved (B18).

import {
  checkMailSlot,
  ensureOk,
  type MailAccount,
  type MailRequest,
} from "./mailbox.ts";
import { MAIL_SLOTS } from "./tools.ts";

const GMAIL = "https://gmail.googleapis.com/gmail/v1/users/me";
const GRAPH = "https://graph.microsoft.com/v1.0/me";

export interface MessageRef {
  provider: "gmail" | "graph";
  slot: string;
  message_id: string;
}

// Null when the string is not a mail ref or names a slot outside the three
// open mailboxes (icai included), so a caller never resolves it.
export function parseMessageRef(ref: unknown): MessageRef | null {
  if (typeof ref !== "string") return null;
  const m = /^(gmail|graph):([a-z_]+):(.+)$/.exec(ref.trim());
  if (!m || !MAIL_SLOTS.includes(m[2])) return null;
  return { provider: m[1] as "gmail" | "graph", slot: m[2], message_id: m[3] };
}

// The thread of one message: Gmail threadId, Graph conversationId. Null when
// the provider does not have the message any more.
export async function resolveMessageThread(
  request: MailRequest,
  account: MailAccount,
  messageId: string
): Promise<string | null> {
  const google = account.provider === "google";
  const res = await request(
    google
      ? `${GMAIL}/messages/${encodeURIComponent(messageId)}?` +
          new URLSearchParams({ format: "minimal", fields: "threadId" })
      : `${GRAPH}/messages/${encodeURIComponent(messageId)}?` +
          new URLSearchParams({ $select: "conversationId" })
  );
  if (res.status === 400 || res.status === 404) return null;
  await ensureOk(res, account.slot, "Looking up the message");
  const j = (await res.json()) as { threadId?: string; conversationId?: string };
  return (google ? j.threadId : j.conversationId) || null;
}

// ---------------------------------------------------------------------------
// lifeos_read_mail_thread: exactly one of message_ref, or account + thread_id
// ---------------------------------------------------------------------------

export interface ThreadTarget {
  slot: string;
  thread_id: string | null;
  message_id: string | null;
  provider: "gmail" | "graph" | null;
}

export function checkThreadTarget(input: Record<string, unknown>): ThreadTarget {
  const has = (v: unknown) => typeof v === "string" ? v.trim() !== "" : v !== undefined && v !== null;
  const hasRef = has(input.message_ref);
  const hasPair = has(input.account) || has(input.thread_id);
  if (hasRef && hasPair) {
    throw new Error("Give either message_ref, or account and thread_id, not both.");
  }
  if (!hasRef && !hasPair) {
    throw new Error(
      "Give message_ref (a task's mail ref), or account and thread_id (the task's mail_account and mail_thread_id)."
    );
  }
  if (!hasRef) {
    // account + thread_id: their own checks run in the caller, as before B27.
    return { slot: checkMailSlot(input.account), thread_id: null, message_id: null, provider: null };
  }
  const ref = parseMessageRef(input.message_ref);
  if (!ref) {
    // Name the icai refusal rather than calling its ref malformed.
    if (typeof input.message_ref === "string" && /^(gmail|graph):icai:/.test(input.message_ref.trim())) {
      checkMailSlot("icai");
    }
    throw new Error(
      "message_ref must be a task's external_ref, like gmail:<account>:<message id> or graph:<account>:<message id>."
    );
  }
  return { slot: ref.slot, thread_id: null, message_id: ref.message_id, provider: ref.provider };
}

// The thread id to read: the one given, or the one found from the message ref.
export async function threadIdFor(
  request: MailRequest,
  account: MailAccount,
  target: ThreadTarget,
  given: unknown
): Promise<string> {
  if (!target.message_id) return typeof given === "string" ? given : "";
  const want = account.provider === "google" ? "gmail" : "graph";
  if (target.provider !== want) {
    throw new Error(`message_ref says ${target.provider} but ${account.slot} is a ${want} mailbox.`);
  }
  const thread = await resolveMessageThread(request, account, target.message_id);
  if (!thread) {
    throw new Error(
      `No mail message for that message_ref in ${account.slot}. It may have been deleted; search with lifeos_list_inbox and a query.`
    );
  }
  return thread;
}

// ---------------------------------------------------------------------------
// Task rows: mail_account and mail_thread_id
// ---------------------------------------------------------------------------

export interface TaskMailRow {
  id: string;
  source: string | null;
  external_ref: string | null;
  external_thread: string | null;
}

export interface TaskMail {
  mail_account: string | null;
  mail_thread_id: string | null;
}

export interface TaskMailDeps {
  // The connected account for a slot, or null when there is none to use.
  accountFor: (slot: string) => Promise<MailAccount | null>;
  request: (account: MailAccount) => MailRequest;
  // Stores a resolved thread id on the task, once (only while it is empty).
  writeBack: (taskId: string, thread: string) => Promise<void>;
}

// ponytail: at most this many provider lookups per call, so a long list of old
// rows cannot make one read slow; the rest resolve on the next read.
export const RESOLVE_PER_CALL = 10;

const NONE: TaskMail = { mail_account: null, mail_thread_id: null };

export async function taskMailFields(
  rows: TaskMailRow[],
  deps: TaskMailDeps
): Promise<Map<string, TaskMail>> {
  const out = new Map<string, TaskMail>();
  const accounts = new Map<string, MailAccount | null>();
  let lookups = 0;
  for (const row of rows) {
    const ref = row.source === "email" ? parseMessageRef(row.external_ref) : null;
    if (!ref) {
      out.set(row.id, NONE);
      continue;
    }
    let thread = row.external_thread || null;
    if (!thread && lookups < RESOLVE_PER_CALL) {
      if (!accounts.has(ref.slot)) accounts.set(ref.slot, await deps.accountFor(ref.slot).catch(() => null));
      const account = accounts.get(ref.slot);
      if (account) {
        lookups++;
        // A provider failure must not fail the task list: the agent can still
        // pass message_ref to lifeos_read_mail_thread.
        thread = await resolveMessageThread(deps.request(account), account, ref.message_id).catch(() => null);
        if (thread) await deps.writeBack(row.id, thread).catch(() => undefined);
      }
    }
    out.set(row.id, { mail_account: ref.slot, mail_thread_id: thread });
  }
  return out;
}

