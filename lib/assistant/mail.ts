// Recent-mail metadata fetchers. The confidential boundary lives here too:
// Gmail is queried in metadata format (headers plus snippet, never the body,
// never attachment parts) and Graph selects only subject, from, the
// conversation id and bodyPreview. Links inside mail arrive as inert strings
// inside the snippet. Since B20 the scan also reads the body text and PDF
// ticket attachments of mail from allowlisted ticket senders only, through
// lib/assistant/mailbox.ts readTicketMail; no other attachment is fetched.
// Every call routes through withResourceAuth (401 retry, revocation to
// needs_reauth).

import { withResourceAuth } from "@/lib/oauth/tokens";
import type { MailRequest } from "@/lib/assistant/mailbox";
import { NIGHTLY_DAYS, PER_ACCOUNT_MESSAGES, targetedCap } from "@/lib/assistant/scan-args";
import { mailReadSenders, mayReadMailContent } from "@/lib/assistant/scan-filters";

// B18: the authorised request the pure mailbox module (inbox, thread, reply
// draft) is handed. Same withResourceAuth path as every other resource call,
// so a dead token flips needs_reauth and a 403 comes back as a response for
// mailbox.ts to read as a scope shortfall.
export function mailRequest(accountId: string): MailRequest {
  return (url, init = {}) =>
    withResourceAuth(accountId, (token) =>
      fetch(url, {
        ...init,
        headers: {
          ...(init.headers as Record<string, string> | undefined),
          authorization: `Bearer ${token}`,
        },
      })
    );
}

export interface MailMeta {
  id: string;
  from: string;
  subject: string;
  date: string;
  snippet: string;
  // Gmail only: used to spot calendar invitations structurally.
  contentType?: string;
  // X-Life-OS when present: the app stamps its own outgoing mail so the scan
  // can refuse to read it back in (lib/assistant/scan-filters.ts).
  appTag?: string;
  // B20: Gmail threadId, Graph conversationId. An id, used only to drop a
  // mail whose thread already has a task.
  threadId?: string;
  // B34: true when the message came only from the targeted sender fetch, not
  // the newest-N list. Counted in the scan's audit row.
  targeted?: boolean;
}

// B24: the nightly scan reads 3 days and 15 messages a mailbox. A hand-run
// catch-up passes a wider window through the limits argument (built by
// scanLimits in scan-args.ts); the defaults here are the nightly numbers.
export interface MailWindow {
  days: number;
  messages: number;
}
const NIGHTLY_WINDOW: MailWindow = { days: NIGHTLY_DAYS, messages: PER_ACCOUNT_MESSAGES };

// B34: merge the newest-N list with the targeted sender list. Duplicates by
// id are read once; only messages a content-readable sender sent can come in
// through the targeted list (the sender filter is a hint, this is the rule);
// newest first.
function mergeTargeted(main: MailMeta[], extra: MailMeta[]): MailMeta[] {
  const seen = new Set(main.map((m) => m.id));
  const added = extra.filter((m) => !seen.has(m.id) && mayReadMailContent(m.from));
  if (!added.length) return main;
  const key = (m: MailMeta) => Date.parse(m.date) || 0;
  return [...main, ...added.map((m) => ({ ...m, targeted: true }))].sort((a, b) => key(b) - key(a));
}

export async function listRecentGmail(
  accountId: string,
  window: MailWindow = NIGHTLY_WINDOW
): Promise<MailMeta[]> {
  const main = await gmailList(accountId, `newer_than:${window.days}d in:inbox`, window.messages);
  // The targeted fetch is extra reach, never a reason to fail the scan.
  // The query is built from the constant allowlists only.
  const extra = await gmailList(
    accountId,
    `newer_than:${window.days}d in:inbox from:(${mailReadSenders().join(" OR ")})`,
    targetedCap(window.days)
  ).catch(() => []);
  return mergeTargeted(main, extra);
}

async function gmailList(accountId: string, q: string, max: number): Promise<MailMeta[]> {
  const listRes = await withResourceAuth(accountId, (token) =>
    fetch(
      "https://gmail.googleapis.com/gmail/v1/users/me/messages?" +
        new URLSearchParams({
          q,
          maxResults: String(max),
        }),
      { headers: { authorization: `Bearer ${token}` } }
    )
  );
  if (!listRes.ok) throw new Error(`Gmail list failed (${listRes.status}).`);
  const list = (await listRes.json()) as { messages?: { id: string; threadId?: string }[] };
  const out: MailMeta[] = [];
  for (const m of list.messages ?? []) {
    const res = await withResourceAuth(accountId, (token) =>
      fetch(
        `https://gmail.googleapis.com/gmail/v1/users/me/messages/${m.id}?` +
          new URLSearchParams({
            format: "metadata",
            metadataHeaders: "From",
          }) +
          "&metadataHeaders=Subject&metadataHeaders=Date&metadataHeaders=Content-Type&metadataHeaders=X-Life-OS",
        { headers: { authorization: `Bearer ${token}` } }
      )
    );
    if (!res.ok) continue;
    const j = (await res.json()) as {
      id: string;
      threadId?: string;
      snippet?: string;
      payload?: { headers?: { name: string; value: string }[] };
    };
    const header = (name: string) =>
      j.payload?.headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())
        ?.value ?? "";
    out.push({
      id: j.id,
      from: header("From"),
      subject: header("Subject"),
      date: header("Date"),
      snippet: j.snippet ?? "",
      contentType: header("Content-Type"),
      appTag: header("X-Life-OS"),
      threadId: j.threadId ?? m.threadId,
    });
  }
  return out;
}

export async function listRecentGraph(
  accountId: string,
  window: MailWindow = NIGHTLY_WINDOW
): Promise<MailMeta[]> {
  const since = new Date(Date.now() - window.days * 86400000).toISOString();
  const main = await graphList(accountId, `receivedDateTime ge ${since}`, window.messages);
  // B34: the same sender list, as a Graph filter built from the constants.
  const senders = mailReadSenders()
    .map((s) => `contains(from/emailAddress/address,'${s}')`)
    .join(" or ");
  const extra = await graphList(
    accountId,
    `receivedDateTime ge ${since} and (${senders})`,
    targetedCap(window.days)
  ).catch(() => []);
  return mergeTargeted(main, extra);
}

async function graphList(accountId: string, filter: string, top: number): Promise<MailMeta[]> {
  const res = await withResourceAuth(accountId, (token) =>
    fetch(
      "https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages?" +
        new URLSearchParams({
          $top: String(top),
          $orderby: "receivedDateTime desc",
          $select: "id,conversationId,subject,from,receivedDateTime,bodyPreview",
          $filter: filter,
        }),
      { headers: { authorization: `Bearer ${token}` } }
    )
  );
  if (!res.ok) throw new Error(`Graph mail list failed (${res.status}).`);
  const j = (await res.json()) as {
    value?: {
      id: string;
      conversationId?: string;
      subject?: string;
      from?: { emailAddress?: { name?: string; address?: string } };
      receivedDateTime?: string;
      bodyPreview?: string;
    }[];
  };
  return (j.value ?? []).map((m) => ({
    id: m.id,
    from:
      `${m.from?.emailAddress?.name ?? ""} <${m.from?.emailAddress?.address ?? ""}>`.trim(),
    subject: m.subject ?? "",
    date: m.receivedDateTime ?? "",
    snippet: m.bodyPreview ?? "",
    threadId: m.conversationId,
  }));
}
