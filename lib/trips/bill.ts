// Travel Desk billing logic. Pure and dependency-free (only the shared date
// and money formatters), so the offline suite (scripts/m6.test.ts) can prove
// the parts that decide what Tapas actually claims from the institute:
// the line items derived from expenses, the total, the amount in words, and
// the financial-year bill number.

// Relative .ts import so node --test (type stripping, no bundler) resolves it,
// the same convention lib/tasks/triage.ts and lib/brief/compose.ts use.
import { formatDateIST, formatDateShortIST } from "../datetime.ts";

// ---------------------------------------------------------------------------
// Trip legs
// ---------------------------------------------------------------------------
// Transport preference order, his own, best first. The UI lists modes in this
// order and says why; nothing forces a choice.
export const TRANSPORT_MODES = [
  "vande_bharat",
  "tejas",
  "ac_sleeper",
  "cab",
  "flight",
  "other",
] as const;

export type TransportMode = (typeof TRANSPORT_MODES)[number];

export const MODE_LABELS: Record<TransportMode, string> = {
  vande_bharat: "Vande Bharat",
  tejas: "Tejas",
  ac_sleeper: "AC sleeper",
  cab: "Cab",
  flight: "Flight",
  other: "Other",
};

export const TRANSPORT_HELP =
  "Preference order: Vande Bharat, then Tejas, then AC sleeper, then cab.";

export interface TripLeg {
  from: string;
  to: string;
  date: string; // YYYY-MM-DD
  mode: TransportMode;
  cost: number | null;
}

// legs is jsonb, so anything could be in there. Read it defensively and drop
// what does not parse rather than throwing on a render.
export function parseLegs(raw: unknown): TripLeg[] {
  if (!Array.isArray(raw)) return [];
  const out: TripLeg[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const r = item as Record<string, unknown>;
    const from = typeof r.from === "string" ? r.from : "";
    const to = typeof r.to === "string" ? r.to : "";
    const date = typeof r.date === "string" ? r.date : "";
    if (!from && !to && !date) continue;
    const mode = TRANSPORT_MODES.includes(r.mode as TransportMode)
      ? (r.mode as TransportMode)
      : "other";
    out.push({
      from,
      to,
      date,
      mode,
      cost: typeof r.cost === "number" ? r.cost : null,
    });
  }
  return out.sort((a, b) => a.date.localeCompare(b.date));
}

// ---------------------------------------------------------------------------
// Expenses and line items
// ---------------------------------------------------------------------------
export type ExpenseCategory = "transport" | "hotel" | "per_diem" | "other";

export const EXPENSE_CATEGORIES: ExpenseCategory[] = [
  "transport",
  "hotel",
  "per_diem",
  "other",
];

export const CATEGORY_LABELS: Record<ExpenseCategory, string> = {
  transport: "Transport",
  hotel: "Hotel",
  per_diem: "Per diem",
  other: "Other",
};

export interface BillableExpense {
  id: string;
  category: ExpenseCategory;
  amount: number;
  date: string; // YYYY-MM-DD
  billable: boolean;
}

export interface BillLineItem {
  date: string; // YYYY-MM-DD, the earliest expense in the group
  description: string;
  amount: number;
}

// What the trip can be claimed for. Non-billable expenses are his own cost
// and never reach a bill.
export function billableTotal(expenses: BillableExpense[]): number {
  return round2(
    expenses.filter((e) => e.billable).reduce((sum, e) => sum + e.amount, 0)
  );
}

// One line per category, in the fixed category order, each carrying the
// earliest date in its group. This is a starting draft: the bill builder lets
// him edit every field before saving.
export function deriveLineItems(expenses: BillableExpense[]): BillLineItem[] {
  const billable = expenses.filter((e) => e.billable);
  const items: BillLineItem[] = [];
  for (const category of EXPENSE_CATEGORIES) {
    const group = billable.filter((e) => e.category === category);
    if (!group.length) continue;
    const dates = group.map((e) => e.date).filter(Boolean).sort();
    const first = dates[0] ?? "";
    const last = dates[dates.length - 1] ?? "";
    const span =
      first && last && first !== last
        ? `${formatDate(first)} to ${formatDate(last)}`
        : first
          ? formatDate(first)
          : "";
    const count =
      group.length === 1 ? "1 expense" : `${group.length} expenses`;
    items.push({
      date: first,
      description: `${CATEGORY_LABELS[category]}, ${count}${span ? `, ${span}` : ""}`,
      amount: round2(group.reduce((sum, e) => sum + e.amount, 0)),
    });
  }
  return items;
}

export function lineItemsTotal(items: BillLineItem[]): number {
  return round2(items.reduce((sum, i) => sum + i.amount, 0));
}

// line_items is jsonb; same defensive read as legs.
export function parseLineItems(raw: unknown): BillLineItem[] {
  if (!Array.isArray(raw)) return [];
  const out: BillLineItem[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const r = item as Record<string, unknown>;
    out.push({
      date: typeof r.date === "string" ? r.date : "",
      description: typeof r.description === "string" ? r.description : "",
      amount: typeof r.amount === "number" ? r.amount : 0,
    });
  }
  return out;
}

// A date column holds a bare calendar date; anchoring it to IST keeps the day
// displayed identical to the day stored. Lives here rather than in a client
// component so server components can call it too.
export function dayLabel(dateOnly: string | null, short = false): string {
  if (!dateOnly) return "";
  const iso = `${dateOnly}T00:00:00+05:30`;
  return short ? formatDateShortIST(iso) : formatDateIST(iso);
}

// The date line a trip is known by: "17 to 19 May 2026". Lives here rather
// than in a component so a server render (Home, the Tasks overview, the
// brief) can call it too; components/trips/bits.tsx re-exports nothing, it
// imports from here.
export function tripDatesLabel(start: string | null, end: string | null): string {
  if (!start && !end) return "No dates yet";
  if (start && end && start !== end) {
    // Same month reads better trimmed: "17 to 19 May 2026".
    const sameMonth = start.slice(0, 7) === end.slice(0, 7);
    return sameMonth
      ? `${Number(start.slice(8, 10))} to ${dayLabel(end)}`
      : `${dayLabel(start)} to ${dayLabel(end)}`;
  }
  return dayLabel(start ?? end);
}

function formatDate(dateOnly: string): string {
  return dayLabel(dateOnly);
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

// ---------------------------------------------------------------------------
// Bill numbering: sequential within the Indian financial year (April to March)
// ---------------------------------------------------------------------------

// "2026-27" for any date from 1 April 2026 to 31 March 2027.
export function financialYearLabel(dateOnly: string): string {
  const m = /^(\d{4})-(\d{2})/.exec(dateOnly);
  if (!m) throw new Error(`Invalid date: ${dateOnly}`);
  const year = Number(m[1]);
  const month = Number(m[2]);
  const startYear = month >= 4 ? year : year - 1;
  return `${startYear}-${String((startYear + 1) % 100).padStart(2, "0")}`;
}

// The next number in the series for the bill's own financial year. Numbers
// from other years are ignored, so a March bill and an April bill restart the
// count. The field stays editable in the form: his convention wins.
export function nextBillNumber(
  prefix: string,
  dateOnly: string,
  existingNumbers: string[]
): string {
  const fy = financialYearLabel(dateOnly);
  const head = `${prefix}/${fy}/`;
  let highest = 0;
  for (const n of existingNumbers) {
    if (!n.startsWith(head)) continue;
    const seq = Number(n.slice(head.length).replace(/\D/g, ""));
    if (Number.isFinite(seq) && seq > highest) highest = seq;
  }
  return `${head}${String(highest + 1).padStart(3, "0")}`;
}

// ---------------------------------------------------------------------------
// Amount in words, Indian system (lakhs and crores)
// ---------------------------------------------------------------------------
const ONES = [
  "",
  "One",
  "Two",
  "Three",
  "Four",
  "Five",
  "Six",
  "Seven",
  "Eight",
  "Nine",
  "Ten",
  "Eleven",
  "Twelve",
  "Thirteen",
  "Fourteen",
  "Fifteen",
  "Sixteen",
  "Seventeen",
  "Eighteen",
  "Nineteen",
];
const TENS = [
  "",
  "",
  "Twenty",
  "Thirty",
  "Forty",
  "Fifty",
  "Sixty",
  "Seventy",
  "Eighty",
  "Ninety",
];

function underHundred(n: number): string {
  if (n < 20) return ONES[n];
  const t = TENS[Math.floor(n / 10)];
  const r = n % 10;
  return r ? `${t} ${ONES[r]}` : t;
}

function underThousand(n: number): string {
  const h = Math.floor(n / 100);
  const r = n % 100;
  const parts: string[] = [];
  if (h) parts.push(`${ONES[h]} Hundred`);
  if (r) parts.push(underHundred(r));
  return parts.join(" ");
}

// Indian grouping: crore, lakh, thousand, then the last three digits.
export function numberInWordsIndian(value: number): string {
  const n = Math.floor(Math.abs(value));
  if (n === 0) return "Zero";
  const parts: string[] = [];
  const crore = Math.floor(n / 10000000);
  const lakh = Math.floor((n % 10000000) / 100000);
  const thousand = Math.floor((n % 100000) / 1000);
  const rest = n % 1000;
  // Recursion covers 100 crore and beyond ("One Hundred Twenty Crore").
  if (crore) parts.push(`${numberInWordsIndian(crore)} Crore`);
  if (lakh) parts.push(`${underHundred(lakh)} Lakh`);
  if (thousand) parts.push(`${underHundred(thousand)} Thousand`);
  if (rest) parts.push(underThousand(rest));
  return parts.join(" ");
}

// "Rupees One Lakh Twenty Thousand only", with paise named when there are any.
export function amountInWordsIndian(amount: number): string {
  const abs = Math.abs(amount);
  let rupees = Math.floor(abs);
  let paise = Math.round((abs - rupees) * 100);
  if (paise === 100) {
    rupees += 1;
    paise = 0;
  }
  const head = `Rupees ${numberInWordsIndian(rupees)}`;
  const tail = paise ? ` and ${numberInWordsIndian(paise)} Paise` : "";
  return `${head}${tail} only`;
}
