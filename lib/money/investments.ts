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
import {
  financeReminderMode,
  parseDateKey,
  type FinanceKeyDateType,
} from "../reminders/core.ts";

export type FinanceKind =
  | "fd"
  | "mf"
  | "stock"
  | "ncd"
  | "ppf"
  | "epf"
  | "nps"
  | "ssy"
  | "gold"
  | "savings"
  | "other";

export const FINANCE_KINDS: FinanceKind[] = [
  "fd",
  "mf",
  "stock",
  "ncd",
  "ppf",
  "epf",
  "nps",
  "ssy",
  "gold",
  "savings",
  "other",
];

export const KIND_LABELS: Record<FinanceKind, string> = {
  fd: "Fixed deposit",
  mf: "Mutual fund",
  stock: "Stock",
  ncd: "NCD",
  ppf: "PPF",
  epf: "EPF",
  nps: "NPS",
  ssy: "Sukanya Samriddhi",
  gold: "Gold",
  savings: "Savings balance",
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
  // Whose it is: null for his own, else a relation label such as "Mother".
  held_for: string | null;
  // Kept on record only (his wife's, his parents-in-law's): never on the
  // dashboard, Home, the brief or the calendar. Its own section on Money only.
  reference_only: boolean;
  // Portfolio fields (16 Oct 2026): a fund's SEBI category key, an equity
  // share override, and the amount invested where a statement gives it.
  fund_category: string | null;
  equity_pct: number | null;
  invested: number | null;
}

// The name with its holder, for any surface that mixes everyone's holdings
// (Home, the brief): "SBI FD (Mother)". His own read as plain names.
export function holdingLabel(h: Pick<Holding, "name" | "held_for">): string {
  return h.held_for ? `${h.name} (${h.held_for})` : h.name;
}

export interface HolderGroup {
  held_for: string | null;
  title: string;
  reference_only: boolean;
  items: Holding[];
}

// The holdings that count: his own and the ones he manages. Everything that
// summarises (the dashboard, Home, the brief) reads only these.
export function managedHoldings(items: Holding[]): Holding[] {
  return items.filter((h) => !h.reference_only);
}

// One group per holder and kind of record, so a person can never be split
// across the dashboard and the reference shelf without it showing. Labels
// match ignoring case and edge spaces ("Mother" and "mother " are one person).
// Order: his own, then the people he manages, then reference-only, each
// alphabetical. Each group is totalled on its own.
export function groupByHolder(items: Holding[]): HolderGroup[] {
  const groups = new Map<string, HolderGroup>();
  for (const h of items) {
    const label = h.held_for?.trim() || null;
    const key = `${h.reference_only ? 1 : 0}|${label?.toLowerCase() ?? ""}`;
    if (!groups.has(key)) {
      groups.set(key, {
        held_for: label,
        title: label ? `Held for ${label}` : "Yours",
        reference_only: h.reference_only,
        items: [],
      });
    }
    groups.get(key)!.items.push(h);
  }
  return [...groups.entries()]
    .sort(([a], [b]) => {
      const [ra, la] = a.split("|");
      const [rb, lb] = b.split("|");
      if (ra !== rb) return ra.localeCompare(rb);
      if (la === "") return -1;
      if (lb === "") return 1;
      return la.localeCompare(lb);
    })
    .map(([, g]) => g);
}

// The dashboard: his and the managed holdings together. Reference-only ones
// never enter it. Upcoming maturities look 90 days ahead: an FD needs a
// decision weeks before it matures, not on the day.
export const MATURITY_HORIZON_DAYS = 90;

export interface Dashboard {
  total: number;
  count: number;
  by_holder: { title: string; count: number; total: number }[];
  by_kind: KindTotal[];
  maturing: { id: string; label: string; key_date: string; value: number | null }[];
  reviews: ReviewDue[];
}

export function dashboard(items: Holding[], todayKey: string): Dashboard {
  const managed = managedHoldings(items);
  const today = parseDateKey(todayKey);
  const horizonKey = civilKey(addDays(today, MATURITY_HORIZON_DAYS));
  return {
    total: totalValue(managed),
    count: managed.length,
    by_holder: groupByHolder(managed).map((g) => ({
      title: g.held_for ?? "You",
      count: g.items.length,
      total: totalValue(g.items),
    })),
    by_kind: totalsByKind(managed),
    maturing: dated(managed, "maturity", todayKey)
      .filter((h) => h.key_date! <= horizonKey)
      .map((h) => ({ id: h.id, label: holdingLabel(h), key_date: h.key_date!, value: h.value })),
    reviews: reviewsDue(managed, todayKey, reviewHorizonKey(today)),
  };
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
// silently pretends the unpriced one is worth zero. Where NOTHING in a kind
// carries a value the label says "not valued" rather than printing Rs 0,
// which would be a figure he could believe.
export function totalsByKind(items: Holding[]): KindTotal[] {
  return FINANCE_KINDS.map((kind) => {
    const of = items.filter((h) => h.kind === kind);
    const total = of.reduce((sum, h) => sum + (h.value ?? 0), 0);
    const unpriced = of.every((h) => h.value == null);
    return {
      kind,
      label: KIND_LABELS[kind],
      count: of.length,
      total,
      total_label: unpriced ? "not valued" : formatINR(total),
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
  return managedHoldings(items)
    .filter((h) => h.key_date_type === "review" && h.key_date && h.key_date <= horizonKey)
    .sort((a, b) => a.key_date!.localeCompare(b.key_date!))
    .map((h) => ({
      id: h.id,
      name: holdingLabel(h),
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
  return !h.reference_only && h.remind && !!h.key_date && financeReminderMode(h.key_date_type) === "calendar";
}
