// Travel Desk trip logic: legs, expenses and the date lines a trip is known
// by. Pure and dependency-free (only the shared date formatters), so the
// offline suite (scripts/m6.test.ts) can prove it without a database.
//
// M6d removed the bill builder from this app: Life OS does not produce a
// bill, it feeds the monthly invoice run (lib/trips/month.ts). Bill
// numbering, bill line items and amount-in-words went with it. The file name
// is unchanged only to keep the M6d diff small.

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
// Expenses
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

// What the trip can be claimed for. Non-billable expenses are his own cost
// and never reach the monthly claim.
export function billableTotal(expenses: BillableExpense[]): number {
  return round2(
    expenses.filter((e) => e.billable).reduce((sum, e) => sum + e.amount, 0)
  );
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

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
