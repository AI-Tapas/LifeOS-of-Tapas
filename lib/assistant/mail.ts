// Recent-mail metadata fetchers. The confidential boundary lives here too:
// Gmail is queried in metadata format (headers plus snippet, never the body,
// never attachment parts) and Graph selects only subject, from and
// bodyPreview. Links inside mail arrive as inert strings inside the snippet.
// Every call routes through withResourceAuth (401 retry, revocation to
// needs_reauth).

import { withResourceAuth } from "@/lib/oauth/tokens";

export interface MailMeta {
  id: string;
  from: string;
  subject: string;
  date: string;
  snippet: string;
  // Gmail only: used to spot calendar invitations structurally.
  contentType?: string;
}

const LOOKBACK_DAYS = 3;
const PER_ACCOUNT = 15;

export async function listRecentGmail(accountId: string): Promise<MailMeta[]> {
  const listRes = await withResourceAuth(accountId, (token) =>
    fetch(
      "https://gmail.googleapis.com/gmail/v1/users/me/messages?" +
        new URLSearchParams({
          q: `newer_than:${LOOKBACK_DAYS}d in:inbox`,
          maxResults: String(PER_ACCOUNT),
        }),
      { headers: { authorization: `Bearer ${token}` } }
    )
  );
  if (!listRes.ok) throw new Error(`Gmail list failed (${listRes.status}).`);
  const list = (await listRes.json()) as { messages?: { id: string }[] };
  const out: MailMeta[] = [];
  for (const m of list.messages ?? []) {
    const res = await withResourceAuth(accountId, (token) =>
      fetch(
        `https://gmail.googleapis.com/gmail/v1/users/me/messages/${m.id}?` +
          new URLSearchParams({
            format: "metadata",
            metadataHeaders: "From",
          }) +
          "&metadataHeaders=Subject&metadataHeaders=Date&metadataHeaders=Content-Type",
        { headers: { authorization: `Bearer ${token}` } }
      )
    );
    if (!res.ok) continue;
    const j = (await res.json()) as {
      id: string;
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
    });
  }
  return out;
}

export async function listRecentGraph(accountId: string): Promise<MailMeta[]> {
  const since = new Date(Date.now() - LOOKBACK_DAYS * 86400000).toISOString();
  const res = await withResourceAuth(accountId, (token) =>
    fetch(
      "https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages?" +
        new URLSearchParams({
          $top: String(PER_ACCOUNT),
          $orderby: "receivedDateTime desc",
          $select: "id,subject,from,receivedDateTime,bodyPreview",
          $filter: `receivedDateTime ge ${since}`,
        }),
      { headers: { authorization: `Bearer ${token}` } }
    )
  );
  if (!res.ok) throw new Error(`Graph mail list failed (${res.status}).`);
  const j = (await res.json()) as {
    value?: {
      id: string;
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
  }));
}
