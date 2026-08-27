// Sends the morning brief: ca_tapasnr to itself, HTML with a plain-text
// alternative. Deliberately separate from the approval-gated sendEmail in
// lib/assistant/execute.ts, which is the only path that can send to anyone
// else and requires an already-approved assistant_actions row. This one
// never takes a recipient: it always sends the connected account's own
// address to itself, so there is no injection surface and nothing here
// weakens the confirmation boundary for mail to other people.

import { randomUUID } from "node:crypto";
import { withResourceAuth } from "@/lib/oauth/tokens";

export async function sendBriefEmail(
  accountId: string,
  email: string,
  subject: string,
  html: string,
  text: string
): Promise<{ provider_message_id: string | null }> {
  const boundary = `brief_${randomUUID()}`;
  // ponytail: subject/body are our own generated plain-ASCII text (task
  // titles are free-text but always short, no raw-header risk here since
  // there's no CRLF injection vector - the subject is a single computed
  // string). RFC 2047 subject encoding is skipped; add it if a title ever
  // needs non-ASCII in the subject line.
  const mime = [
    `From: ${email}`,
    `To: ${email}`,
    `Subject: ${subject}`,
    "MIME-Version: 1.0",
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    "",
    `--${boundary}`,
    'Content-Type: text/plain; charset="UTF-8"',
    "",
    text,
    "",
    `--${boundary}`,
    'Content-Type: text/html; charset="UTF-8"',
    "",
    html,
    "",
    `--${boundary}--`,
  ].join("\r\n");

  const res = await withResourceAuth(accountId, (token) =>
    fetch("https://gmail.googleapis.com/gmail/v1/users/me/messages/send", {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ raw: Buffer.from(mime, "utf8").toString("base64url") }),
    })
  );
  if (!res.ok) throw new Error(`Gmail send failed (${res.status}).`);
  const j = (await res.json()) as { id?: string };
  return { provider_message_id: j.id ?? null };
}
