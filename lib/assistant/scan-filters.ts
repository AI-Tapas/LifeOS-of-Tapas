// Pure filters that keep the mail scan from feeding on its own output.
// Zero imports on purpose so scripts/m5.test.ts can load this directly under
// node --test type-stripping, same convention as lib/oauth/core.ts.
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

export function isAlreadyOpen(title: string, openTitles: Iterable<string>): boolean {
  const key = normaliseTitle(title);
  for (const t of openTitles) {
    if (normaliseTitle(t) === key) return true;
  }
  return false;
}
