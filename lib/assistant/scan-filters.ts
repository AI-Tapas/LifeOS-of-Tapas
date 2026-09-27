// Pure filters that keep the mail scan from feeding on its own output.
// The one import is the pure, import-free near-duplicate scorer (B19), by a
// relative .ts path, so scripts/m5.test.ts can still load this directly under
// node --test type-stripping, same convention as lib/tasks/triage.ts.

import { createHash } from "node:crypto";
import { duplicateScore, NEAR_DUPLICATE_THRESHOLD, titleTokens } from "../tasks/near-duplicate.ts";
//
// Why this exists: the 7 AM brief is sent from ca_tapasnr to itself, so it
// lands in the very inbox the 3 AM scan reads. The scanner saw its own brief
// as ordinary mail and re-filed the tasks the brief was reporting. Each
// morning is a new message id, so the external_ref dedup never fired, and the
// loop added one copy of the same task per day.

export interface ScanFilterMail {
  from: string;
  subject: string;
  // Value of the X-Life-OS header when the provider returned one.
  appTag?: string;
}

// Subject prefix of the morning brief (lib/brief/compose.ts). Briefs sent
// before the X-Life-OS header existed carry no tag, so the prefix is what
// catches those still sitting in the inbox.
const BRIEF_SUBJECT_PREFIX = "your day:";

// An address header is "Name <addr@host>" or a bare address.
export function addressOf(header: string): string {
  const angled = header.match(/<([^>]+)>/);
  return (angled ? angled[1] : header).trim().toLowerCase();
}

// True when this message is something Life OS itself sent to the mailbox it
// is now scanning. Deliberately NOT "any mail from myself": mailing yourself
// a reminder is a real habit and must still become a task. Only the app's
// own output is excluded, identified by its tag or by the brief's fixed
// subject prefix on a message the account sent to itself.
export function isAppGeneratedMail(
  mail: ScanFilterMail,
  accountEmail: string | null
): boolean {
  if (mail.appTag && mail.appTag.trim()) return true;
  if (!accountEmail) return false;
  if (addressOf(mail.from) !== accountEmail.trim().toLowerCase()) return false;
  return mail.subject.trim().toLowerCase().startsWith(BRIEF_SUBJECT_PREFIX);
}

// Mail a machine sent that needs no reply: bills, statements, alerts, codes,
// bounces, AGM notices. The scan prompt asks the model to skip these and the
// live list showed it did not (Jio bill, AWS invoice, Azure bill, an AGM
// e-vote, a bounce, a Google security alert, an AWS budget alert), so the
// rule is code. Subject and sender only: no body is read here.
// ponytail: a word list, not a classifier. Add a word when a class of noise
// gets through; never add a sender he actually corresponds with.
const NOISE_SUBJECT =
  /\b(invoice|bill|statement|receipt|payment (received|successful|confirmation|due|reminder)|e-?voting|agm|annual general meeting|budget alert|usage alert|security alert|sign-?in|new device|verification code|one[- ]time password|otp|delivery status|undeliverable|mail delivery|delivery failed|newsletter|unsubscribe)\b/i;
const NOISE_SENDER =
  /^(mailer-daemon|postmaster|no-?reply|do-?not-?reply|donotreply|noreply|alerts?|billing|notifications?|bounce)@/i;

export function isNoiseMail(mail: ScanFilterMail): boolean {
  // B20: a ticket sender is taken out of the noise filters, because its
  // e-ticket mail is exactly the "receipt" and "no-reply" mail they drop.
  if (isTicketSender(mail.from)) return false;
  const from = addressOf(mail.from);
  return NOISE_SENDER.test(from) || NOISE_SUBJECT.test(mail.subject);
}

// Same task, different email. The external_ref dedup only recognises the same
// MESSAGE twice; two AWS budget alerts, or two chasers on one thread, are
// different messages saying the same thing. Compare on a normalised title so
// a scan never adds work that is already open on the list.
export function normaliseTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/[\s ]+/g, " ")
    // Trim before stripping punctuation: a title ending ". " would otherwise
    // keep its full stop and never match the same title without one.
    .trim()
    .replace(/[.,;:!?]+$/, "")
    .trim();
}

// Since B19 "the same task" also means a near duplicate: the same words give
// or take punctuation and filler ("raise the AICA invoice - September" is
// "Raise AICA invoice for September"), with the month kept, so next month's
// occurrence is never mistaken for this one. lib/tasks/near-duplicate.ts.
// Since B20 it also catches the pairs the 27 September brief carried, where
// the wording differed but the thing did not: see sameDistinctThing below.
export function isAlreadyOpen(title: string, openTitles: Iterable<string>): boolean {
  const key = normaliseTitle(title);
  for (const t of openTitles) {
    if (normaliseTitle(t) === key) return true;
    if (duplicateScore(title, t) >= NEAR_DUPLICATE_THRESHOLD) return true;
    if (sameDistinctThing(title, t)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// B20. Tighter duplicate check for the scan.
//
// Two titles are the same work when their periods agree (the B19 month rule,
// read through duplicateScore returning 0) and either
//   (a) they share a distinctive token (a document code such as INC-20A, a
//       batch number, or a counterparty name) and at least two words in all,
//       with half the shorter title in common; or
//   (b) three quarters of the shorter title's words appear in the longer.
// Either way they are NOT the same when each names a counterparty the other
// does not ("Clientco GST notice reply" is not "Otherco GST notice reply").
// ponytail: a counterparty is a capitalised word that is not on a short list
// of verbs and house words. A verb missing from the list can hide a real
// pair; add it to GENERIC_WORDS when one gets through. It can also merge an
// onward and a return ticket for one city, which is why this runs in the mail
// scan only and never refuses his own form or the chat's create_task.
// ---------------------------------------------------------------------------
const GENERIC_WORDS = new Set([
  // verbs a task title starts with
  "accept", "arrange", "ask", "attend", "book", "call", "check", "collect",
  "complete", "confirm", "coordinate", "decline", "draft", "email", "file",
  "fill", "finalise", "finalize", "follow", "forward", "get", "give", "join",
  "look", "mail", "make", "note", "pay", "plan", "prepare", "raise", "read",
  "register", "remind", "renew", "reply", "request", "respond", "review",
  "revert", "schedule", "see", "send", "set", "share", "sign", "submit",
  "track", "update", "upload", "verify", "write",
  // house words that name his own world rather than a counterparty
  "aica", "icai", "batch", "level", "day", "invoice", "tax", "strategia",
  "altechon", "personal", "health", "faculty", "session", "meeting",
]);

const MONTH_WORDS = new Set([
  "jan", "january", "feb", "february", "mar", "march", "apr", "april", "may",
  "jun", "june", "jul", "july", "aug", "august", "sep", "sept", "september",
  "oct", "october", "nov", "november", "dec", "december",
]);

// Document codes (INC-20A, GSTR-1, DIR3), batch numbers and counterparty
// names, in comparable form.
export function distinctTokens(title: string): { codes: Set<string>; names: Set<string> } {
  const codes = new Set<string>();
  for (const m of title.matchAll(/\b([A-Za-z]{2,})-?(\d+[A-Za-z]?)\b/g)) {
    codes.add(`${m[1]}${m[2]}`.toLowerCase());
  }
  for (const m of title.matchAll(/\bbatch(?:es)?\s*(?:no\.?|#)?\s*(\d+(?:\s*[/,&]\s*\d+)*)/gi)) {
    for (const n of m[1].split(/\D+/)) if (n) codes.add(`batch${n}`);
  }
  const names = new Set<string>();
  for (const w of title.split(/[^\p{L}\p{N}]+/u)) {
    // Capitalised and not all capitals: "Clientco" is a name, "MSA" and "ROC"
    // are kinds of document or office, which two clients can share.
    if (!/^\p{Lu}\p{L}{2,}$/u.test(w) || w === w.toUpperCase()) continue;
    const lw = w.toLowerCase();
    if (GENERIC_WORDS.has(lw) || MONTH_WORDS.has(lw)) continue;
    names.add(lw);
  }
  return { codes, names };
}

export function sameDistinctThing(a: string, b: string): boolean {
  // 0 means different periods, or nothing in common at all.
  if (duplicateScore(a, b) === 0) return false;
  const da = distinctTokens(a);
  const db = distinctTokens(b);
  const onlyA = [...da.names].some((n) => !db.names.has(n));
  const onlyB = [...db.names].some((n) => !da.names.has(n));
  if (onlyA && onlyB) return false;
  const ta = new Set(titleTokens(a));
  const tb = new Set(titleTokens(b));
  let shared = 0;
  for (const t of ta) if (tb.has(t)) shared += 1;
  const cover = shared / Math.min(ta.size, tb.size);
  const sharesDistinct =
    [...da.codes].some((c) => db.codes.has(c)) || [...da.names].some((n) => db.names.has(n));
  if (sharesDistinct && shared >= 2 && cover >= 0.5) return true;
  return shared >= 3 && cover >= 0.75;
}

// ---------------------------------------------------------------------------
// B20. Standing boilerplate is never a task.
//
// A travel desk footer asks for the boarding pass after every journey; the
// scan filed it as a task, twice. The prompt now says footers are not
// actions; this is the belt under it. Phrases only, matched on the proposed
// title and note (never on mail text), and the audit row records the phrase.
// ponytail: a constant list, no settings screen. Add a phrase when a footer
// gets through.
// ---------------------------------------------------------------------------
export const NEVER_EXTRACT_PHRASES: readonly string[] = ["boarding pass"];

export function matchesNeverExtract(title: string, note: string | null = null): string | null {
  const hay = `${title}\n${note ?? ""}`.toLowerCase();
  return NEVER_EXTRACT_PHRASES.find((p) => hay.includes(p)) ?? null;
}

// ---------------------------------------------------------------------------
// B20. Ticket senders: their mail (and, for them only, its PDF tickets) is
// read for a trip leg and never becomes a task.
//
// Confirmed from a real travel desk email on 27 September 2026: the ICAI
// travel desk writes from traveldesk@icai.in with the booking agent, Sharp
// Travels, in cc; the agent sends e-tickets from etickets@sharpmail.in. The
// body carries only a standing footer; the tickets are PDF attachments.
// ---------------------------------------------------------------------------
export const TICKET_SENDER_ADDRESSES: readonly string[] = [
  "traveldesk@icai.in",
  "etickets@sharpmail.in",
];
// Whole domains, matched on the domain itself or any subdomain of it.
export const TICKET_SENDER_DOMAINS: readonly string[] = [
  "irctc.co.in",
  "goindigo.in",
  "airindia.com",
  "airindia.in",
  "airvistara.com",
  "akasaair.com",
];

export function isTicketSender(from: string): boolean {
  const addr = addressOf(from);
  if (TICKET_SENDER_ADDRESSES.includes(addr)) return true;
  const domain = addr.split("@")[1] ?? "";
  if (!domain) return false;
  return TICKET_SENDER_DOMAINS.some((d) => domain === d || domain.endsWith(`.${d}`));
}

// ---------------------------------------------------------------------------
// B20. Thread and resend dedupe, before the model sees anything.
// ---------------------------------------------------------------------------

// "Re: Fwd: RE: Panel for Batch 89" and "panel for batch 89" are one subject.
export function normaliseSubject(subject: string): string {
  return subject
    .replace(/^\s*((re|fw|fwd|aw|wg)\s*(\[\d+\])?\s*:\s*)+/i, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

// What a task keeps of the mail it came from, for the resend check: a hash of
// sender and normalised subject, never the subject itself.
export function sourceKey(from: string, subject: string): string {
  return createHash("sha256")
    .update(`${addressOf(from)}\n${normaliseSubject(subject)}`)
    .digest("hex");
}

export interface KnownMailWork {
  // Threads that already have an open task, or a task created in 45 days.
  threads: Set<string>;
  // source_key values of tasks created in the last 14 days.
  keys: Set<string>;
}

// Splits mail into what the model should see and how much was dropped. A mail
// whose thread already has work, or whose sender and subject match recent
// work, is dropped; so is the second copy of a mail inside the same batch.
export function dropKnownMail<M extends { from: string; subject: string; threadId?: string }>(
  mails: M[],
  known: KnownMailWork
): { kept: M[]; byThread: number; byResend: number } {
  const keys = new Set(known.keys);
  const kept: M[] = [];
  let byThread = 0;
  let byResend = 0;
  for (const m of mails) {
    if (m.threadId && known.threads.has(m.threadId)) {
      byThread += 1;
      continue;
    }
    const key = sourceKey(m.from, m.subject);
    if (keys.has(key)) {
      byResend += 1;
      continue;
    }
    keys.add(key);
    kept.push(m);
  }
  return { kept, byThread, byResend };
}
