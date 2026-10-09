// B31. The pure rules of phone alerts: quiet hours, the daily cap, what an
// alert may say, and where a tap may land. No imports beyond the clock, so
// scripts/b31.test.ts proves every rule offline.
//
// Lock screen privacy: alert text shows on the lock screen. An alert never
// carries an amount, a PNR, an email body or document text. Task titles are
// allowed (Tapas wrote or accepted them).

import { istHour } from "../datetime.ts";
import { isUntrustedSource } from "../tasks/untrusted.ts";

export const QUIET_FROM_HOUR_IST = 22; // 10 PM
export const QUIET_TO_HOUR_IST = 7; // 7 AM
export const ALERT_CAP_PER_DAY = 20;
export const NOTIFY_TITLE_MAX = 60;
export const NOTIFY_BODY_MAX = 140;
// A generated title ("Needs you: <task title>") may be longer than one an
// agent writes, because task titles go up to 140 characters.
export const PUSH_TITLE_MAX = 100;
export const PUSH_BODY_MAX = 140;

// Quiet hours: 22:00 up to, not including, 07:00 IST. Nothing is queued; the
// item is still in the app and in the brief.
export function isQuietHoursIST(now: Date | string): boolean {
  const h = istHour(now);
  return h >= QUIET_FROM_HOUR_IST || h < QUIET_TO_HOUR_IST;
}

// How many alerts went out in the rolling 24 hours, from push_sent audit rows.
export function alertsInWindow(rows: { ts: string }[], nowMs: number): number {
  const since = nowMs - 24 * 3600 * 1000;
  return rows.filter((r) => Date.parse(r.ts) > since).length;
}

// The 21st alert in 24 hours is refused.
export function overAlertCap(sentInWindow: number): boolean {
  return sentInWindow >= ALERT_CAP_PER_DAY;
}

export function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

export function clip(text: string, max: number): string {
  const t = oneLine(text);
  return t.length <= max ? t : t.slice(0, max - 3).trimEnd() + "...";
}

// A tap may only open a path inside the app. Anything else becomes "/".
export function safeAppUrl(raw: unknown): string {
  if (typeof raw !== "string") return "/";
  const t = raw.trim();
  if (!t.startsWith("/") || t.startsWith("//") || t.includes("\\") || /[\u0000-\u001f]/.test(t)) {
    return "/";
  }
  return t;
}

export interface PushMessage {
  title: string;
  body: string;
  url: string;
}

// What goes to the push service: clipped, one line, an in-app path.
export function shapePush(m: { title: string; body: string; url?: string }): PushMessage {
  return {
    title: clip(m.title, PUSH_TITLE_MAX) || "Life OS",
    body: clip(m.body, PUSH_BODY_MAX),
    url: safeAppUrl(m.url),
  };
}

// The agent asked for him. The words of the result never go on the lock
// screen: they can carry client detail.
export function needsYouAlert(taskId: string, taskTitle: string, source?: string | null): PushMessage {
  // An untrusted task (scanned mail, shared text) or a private-looking title
  // never reaches the lock screen: the generic wording is used instead.
  const safe =
    !isUntrustedSource(source) &&
    !looksLikeUrl(taskTitle) &&
    !looksLikeCredential(taskTitle) &&
    !looksPrivate(taskTitle);
  return shapePush({
    title: `Needs you: ${safe ? taskTitle : "a task"}`,
    body: "An agent has a question or needs a decision from you.",
    url: `/tasks?task=${encodeURIComponent(taskId)}`,
  });
}

// The mail scan health line from the 7 AM brief. Names no client and no mail.
export function scanFailedAlert(line: string): PushMessage {
  return shapePush({ title: "Mail scan problem", body: line, url: "/" });
}

// The brief was composed but not emailed, or failed outright. Until now the
// only trace was an audit row nothing reads. The body is fixed text: a raw
// error could carry an address or a provider message.
export function briefNotSentAlert(reason: "reconnect" | "send_failed" | "failed"): PushMessage {
  const body =
    reason === "reconnect"
      ? "Reconnect ca_tapasnr in Settings, then open Home for today's plan."
      : reason === "send_failed"
        ? "The email could not be sent. Open Home for today's plan."
        : "The brief failed before it was composed. Open Home for today's plan.";
  return shapePush({
    title: "Morning brief not sent",
    body,
    url: reason === "reconnect" ? "/settings" : "/",
  });
}

// ---------------------------------------------------------------------------
// lifeos_notify validation
// ---------------------------------------------------------------------------
const SCHEME = /\b[a-z][a-z0-9+.-]*:\/\//i;
const NAMED_SCHEME = /\b(?:https?|ftp|file|javascript|data|mailto|tel|whatsapp|sms):/i;
const WEB_ADDRESS = /\bwww\.|\b[a-z0-9-]+\.(?:com|in|org|net|io|co|gov|edu|app|dev|ly|me)\b(?:\/\S*)?/i;
const CREDENTIAL_WORDS =
  /\b(?:password|passcode|passwd|otp|pin|cvv|secret|api[ _-]?key|token|bearer)\b\s*(?:[:=]|is\b)\s*\S|\b(?:otp|pin|cvv|passcode)\b\s*\d{3,}/i;
const KEY_SHAPES = /\b(?:sk|pk|ghp|gho|xox[a-z]|akia)[-_A-Za-z0-9]{12,}|\beyJ[\w-]{10,}|\b[A-Za-z0-9_-]{32,}\b/i;
// Lock screen privacy: an amount, a PNR or booking id (a run of 9 or more
// digits), a PAN.
const AMOUNT = /(?:₹|\brs\.?|\binr\b)\s*\d/i;
const LONG_DIGITS = /\d[\d\s-]{7,}\d/;
const PAN = /\b[A-Z]{5}\d{4}[A-Z]\b/;

export function looksLikeUrl(text: string): boolean {
  return SCHEME.test(text) || NAMED_SCHEME.test(text) || WEB_ADDRESS.test(text);
}

export function looksLikeCredential(text: string): boolean {
  return CREDENTIAL_WORDS.test(text) || KEY_SHAPES.test(text);
}

export function looksPrivate(text: string): boolean {
  return AMOUNT.test(text) || LONG_DIGITS.test(text) || PAN.test(text);
}

export type NotifyCheck =
  | { ok: true; title: string; body: string }
  | { ok: false; message: string };

// Text is collapsed to one line first (a model's newlines are not an error),
// then measured and screened. task_id is checked against his tasks by the
// executor, which can see the database.
export function checkNotifyText(titleIn: unknown, bodyIn: unknown): NotifyCheck {
  if (typeof titleIn !== "string" || typeof bodyIn !== "string") {
    return { ok: false, message: "title and body must both be text." };
  }
  const title = oneLine(titleIn);
  const body = oneLine(bodyIn);
  if (!title || !body) return { ok: false, message: "title and body must not be empty." };
  if (title.length > NOTIFY_TITLE_MAX) {
    return { ok: false, message: `The title is ${title.length} characters; the limit is ${NOTIFY_TITLE_MAX}. Shorten it.` };
  }
  if (body.length > NOTIFY_BODY_MAX) {
    return { ok: false, message: `The body is ${body.length} characters; the limit is ${NOTIFY_BODY_MAX}. Shorten it.` };
  }
  const both = `${title}\n${body}`;
  if (looksLikeUrl(both)) {
    return { ok: false, message: "An alert cannot contain a link, a web address or a scheme such as http. Say what needs him in words." };
  }
  if (looksLikeCredential(both)) {
    return { ok: false, message: "An alert cannot contain anything that looks like a password, code, key or token." };
  }
  if (looksPrivate(both)) {
    return { ok: false, message: "An alert shows on the lock screen: leave out amounts, reference numbers and PAN. Name the task, not the figures." };
  }
  return { ok: true, title, body };
}
