// B19. "Repeated tasks" was one of the two faults that made Tapas stop using
// the task list. B16 refused an open task with an IDENTICAL title; a chat that
// plans his week twice rarely words a task identically twice, so
// "Raise AICA invoice for September" and "raise the AICA invoice - September"
// both landed. This scores how closely two titles say the same thing.
//
// Pure and import-free, so the executor, the mail scan's filters, the report
// script and scripts/b19.test.ts all load the one implementation.
//
// The method, deliberately simple:
//   1. normalise: lower case, punctuation gone, month abbreviations spelled
//      out ("Sept" is "september"), stop words dropped;
//   2. period tokens (months, four-digit years, Q1 to Q4) must agree exactly,
//      or the titles are different work: the October invoice is not the
//      November invoice however many other words they share;
//   3. otherwise the score is the token overlap (shared words over all
//      words, Jaccard), and 0.8 or more is a near duplicate.
// ponytail: a word-overlap score, not a language model. It will miss a
// paraphrase with different words ("Bill ICAI for Sept"); widen it only when
// a real pair gets through, and never lower the threshold to catch one.

export const NEAR_DUPLICATE_THRESHOLD = 0.8;

const MONTHS: Record<string, string> = {
  jan: "january",
  january: "january",
  feb: "february",
  february: "february",
  mar: "march",
  march: "march",
  apr: "april",
  april: "april",
  // ponytail: "may" is also a verb, so "Ravi may call" carries a period token.
  // Harmless in practice: it only ever makes two titles LESS alike.
  may: "may",
  jun: "june",
  june: "june",
  jul: "july",
  july: "july",
  aug: "august",
  august: "august",
  sep: "september",
  sept: "september",
  september: "september",
  oct: "october",
  october: "october",
  nov: "november",
  november: "november",
  dec: "december",
  december: "december",
};

const MONTH_NUMBER: Record<string, number> = {
  january: 1,
  february: 2,
  march: 3,
  april: 4,
  may: 5,
  june: 6,
  july: 7,
  august: 8,
  september: 9,
  october: 10,
  november: 11,
  december: 12,
};

const STOP_WORDS = new Set([
  "a", "an", "the", "and", "or", "for", "of", "to", "in", "on", "at", "by",
  "with", "from", "as", "is", "be", "it", "its", "this", "that", "my", "our",
  "re", "fw", "fwd",
]);

const YEAR = /^(19|20)\d\d$/;
const QUARTER = /^q[1-4]$/;

function isPeriodToken(t: string): boolean {
  return t in MONTH_NUMBER || YEAR.test(t) || QUARTER.test(t);
}

// The words that carry meaning, in order, month names spelled out.
export function titleTokens(title: string): string[] {
  return title
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean)
    .map((t) => MONTHS[t] ?? t)
    .filter((t) => !STOP_WORDS.has(t));
}

function sameSet(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) return false;
  for (const x of a) if (!b.has(x)) return false;
  return true;
}

// 0 (nothing in common, or different periods) to 1 (the same words).
export function duplicateScore(a: string, b: string): number {
  const ta = new Set(titleTokens(a));
  const tb = new Set(titleTokens(b));
  // A title made only of stop words ("To do") has nothing to compare, so only
  // the same text counts as the same task.
  if (!ta.size || !tb.size) {
    return a.trim().toLowerCase() === b.trim().toLowerCase() ? 1 : 0;
  }
  const pa = new Set([...ta].filter(isPeriodToken));
  const pb = new Set([...tb].filter(isPeriodToken));
  if (!sameSet(pa, pb)) return 0;
  let shared = 0;
  for (const t of ta) if (tb.has(t)) shared += 1;
  return shared / (ta.size + tb.size - shared);
}

// The closest open task at or above the threshold, or null. The caller names
// its id so the model updates that task instead of adding another.
export function findNearDuplicate<T extends { title: string }>(
  title: string,
  open: Iterable<T>,
  threshold = NEAR_DUPLICATE_THRESHOLD
): { task: T; score: number } | null {
  let best: { task: T; score: number } | null = null;
  for (const task of open) {
    const score = duplicateScore(title, task.title);
    if (score >= threshold && (!best || score > best.score)) best = { task, score };
  }
  return best;
}

// For the one-off review report (scripts/report-premature-tasks.ts): the
// month or year a title names, when that period is still in the future on
// todayKey (YYYY-MM-DD, IST). Returns a label such as "October 2026", or null.
// A month with no year is read as its nearest occurrence to today (within six
// months either way, ties to the past), so in September "January" means next
// January and "August" means last August.
// ponytail: the first four-digit year in the title applies to every month in
// it. Good enough for a list he reads and decides on; nothing acts on it.
export function namedFuturePeriod(title: string, todayKey: string): string | null {
  const [ty, tm] = todayKey.split("-").map(Number);
  const tokens = titleTokens(title);
  const years = tokens.filter((t) => YEAR.test(t)).map(Number);
  const nowIndex = ty * 12 + (tm - 1);
  for (const t of tokens) {
    const m = MONTH_NUMBER[t];
    if (!m) continue;
    let y: number;
    if (years.length) {
      y = years[0];
    } else {
      // Nearest occurrence: this year's, or next/last year's if that is closer.
      y = ty;
      let diff = y * 12 + (m - 1) - nowIndex;
      if (diff > 6) y -= 1;
      else if (diff < -6) y += 1;
      diff = y * 12 + (m - 1) - nowIndex;
      if (diff === 6) y -= 1;
    }
    if (y * 12 + (m - 1) > nowIndex) {
      return `${t[0].toUpperCase()}${t.slice(1)} ${y}`;
    }
  }
  const futureYear = years.find((y) => y > ty);
  return futureYear ? String(futureYear) : null;
}
