// Investments: what is maturing next, what is due for review, and what the
// holdings add up to by kind. Pure, so the Money screen, Home, the morning
// brief and scripts/m7b.test.ts all read the same answers.
//
// Confidential boundary, restated here because money invites the breach: a
// holding carries what it is, where it is held as a short human label, what
// it is worth and one date. There is no account number, no folio number, no
// customer id, no statement and no upload, and there is no field that could
// hold one. If a value would be useful to somebody impersonating him, it does
// not belong in this app.
//
// Relative .ts imports so node --test resolves them, the convention every
// pure module here uses.
import { addDays, civilKey, formatINR, type CivilDate } from "../datetime.ts";
import { financeReminderMode, type FinanceKeyDateType } from "../reminders/core.ts";

export type FinanceKind = "fd" | "mf" | "stock" | "ncd" | "other";

export const FINANCE_KINDS: FinanceKind[] = ["fd", "mf", "stock", "ncd", "other"];

export const KIND_LABELS: Record<FinanceKind, string> = {
  fd: "Fixed deposit",
  mf: "Mutual fund",
  stock: "Stock",
  ncd: "NCD",
  other: "Other",
};

// Which kinds normally carry a maturity at all. A stock or an open-ended fund
// has none, so a review date is the only thing keeping it from drifting for
// years, and the form defaults accordingly. Not a rule, only a default: a
// closed-end fund does mature and he can say so.
export const MATURING_KINDS: FinanceKind[] = ["fd", "ncd"];

export function defaultKeyDateType(kind: FinanceKind): FinanceKeyDateType {
  return MATURING_KINDS.includes(kind) ? "maturity" : "review";
}

export interface Holding {
  id: string;
  kind: FinanceKind;
  name: string;
  institution: string | null;
  value: number | null;
  key_date: string | null; // YYYY-MM-DD
  key_date_type: FinanceKeyDateType | null;
  remind: boolean;
  notes: string | null;
}

function dated(
  items: Holding[],
  type: FinanceKeyDateType,
  todayKey: string
): Holding[] {
  return items
    .filter((h) => h.key_date_type === type && h.key_date && h.key_date >= todayKey)
    .sort((a, b) => a.key_date!.localeCompare(b.key_date!));
}

// The next holding to mature, and the next one due for review. todayKey is
// the IST calendar day, so a date still counts as coming up right through the
// day it falls on and stops the moment IST rolls over, not when UTC does.
export function nextMaturity(items: Holding[], todayKey: string): Holding | null {
  return dated(items, "maturity", todayKey)[0] ?? null;
}

export function nextReview(items: Holding[], todayKey: string): Holding | null {
  return dated(items, "review", todayKey)[0] ?? null;
}

export interface KindTotal {
  kind: FinanceKind;
  label: string;
  count: number;
  total: number;
  total_label: string;
}

// Total by kind, in the order FINANCE_KINDS declares, skipping kinds he holds
// nothing of. A holding with no value counts in the count and adds nothing to
// the total: an honest "3 holdings, Rs 12,00,000 recorded" beats a total that
// silently pretends the unpriced one is worth zero.
export function totalsByKind(items: Holding[]): KindTotal[] {
  return FINANCE_KINDS.map((kind) => {
    const of = items.filter((h) => h.kind === kind);
    const total = of.reduce((sum, h) => sum + (h.value ?? 0), 0);
    return {
      kind,
      label: KIND_LABELS[kind],
      count: of.length,
      total,
      total_label: formatINR(total),
    };
  }).filter((t) => t.count > 0);
}

export function totalValue(items: Holding[]): number {
  return items.reduce((sum, h) => sum + (h.value ?? 0), 0);
}

// ---------------------------------------------------------------------------
// The in-app half: review dates on Home and in the morning brief
// ---------------------------------------------------------------------------
// A review date writes no calendar event, so if it never appeared anywhere it
// would be a date that quietly passes, which is the exact failure this
// milestone exists to stop. These two surfaces are its interruption: they
// reach him whether or not he opens the Money screen.
//
// Overdue reviews are included and lead the list. A review he has walked past
// for three weeks is the one worth naming.
export const REVIEW_HORIZON_DAYS = 14;

export interface ReviewDue {
  id: string;
  name: string;
  institution: string | null;
  key_date: string;
  overdue: boolean;
}

export function reviewsDue(
  items: Holding[],
  todayKey: string,
  horizonKey: string
): ReviewDue[] {
  return items
    .filter((h) => h.key_date_type === "review" && h.key_date && h.key_date <= horizonKey)
    .sort((a, b) => a.key_date!.localeCompare(b.key_date!))
    .map((h) => ({
      id: h.id,
      name: h.name,
      institution: h.institution,
      key_date: h.key_date!,
      overdue: h.key_date! < todayKey,
    }));
}

// The horizon key for a given today, kept here so Home, the brief and the
// tests cannot drift to different windows.
export function reviewHorizonKey(today: CivilDate, days = REVIEW_HORIZON_DAYS): string {
  return civilKey(addDays(today, days));
}

// One plain line for the brief and for the Home card. Null when there is
// nothing to say, so neither surface renders an empty box.
export function reviewLine(due: ReviewDue[]): string | null {
  if (!due.length) return null;
  const overdue = due.filter((d) => d.overdue).length;
  const names = due.slice(0, 3).map((d) => d.name).join(", ");
  if (overdue) {
    return due.length === 1
      ? `${names} is past its review date.`
      : `${overdue} of ${due.length} holdings are past their review date: ${names}.`;
  }
  return due.length === 1
    ? `${names} is due for review.`
    : `${due.length} holdings are due for review: ${names}.`;
}

// Whether this holding interrupts him on the calendar. Exported so the Money
// screen can say so on the row rather than leaving him to infer it.
export function remindsOnCalendar(h: Holding): boolean {
  return h.remind && !!h.key_date && financeReminderMode(h.key_date_type) === "calendar";
}
