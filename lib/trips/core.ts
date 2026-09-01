// Travel Desk trip logic: legs, expenses and the date lines a trip is known
// by. Pure and dependency-free (only the shared date formatters), so the
// offline suite (scripts/m6.test.ts) can prove it without a database.
//
// M6d removed the bill builder from this app: Life OS does not produce a
// bill, it feeds the monthly invoice run (lib/trips/month.ts). Bill
// numbering, bill line items and amount-in-words went with it. This file was
// called bill.ts until M8, which was a lie about its contents; it is named
// for what it is now, the same core.ts convention lib/reminders and
// lib/assistant use.

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

// ---------------------------------------------------------------------------
// Which session a trip is for (M7d)
// ---------------------------------------------------------------------------
// A trip card used to lead with "3 to 5 September 2026", which is the travel
// span. Tapas had to stop and work out which of those days he was actually
// teaching. These build the line that answers that without him thinking:
//
//   "L1D2 · 4 Sept"
//
// Falls back silently: a trip with no session recorded reads exactly as it
// did before, so nothing entered earlier looks broken.

// "4 Sept". Short on purpose: it sits beside the label, not alone, and the
// year is already obvious from the month grouping above it.
export function shortDayLabel(dateOnly: string | null): string {
  if (!dateOnly) return "";
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateOnly);
  if (!m) return "";
  const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sept", "Oct", "Nov", "Dec"];
  return `${Number(m[3])} ${MONTHS[Number(m[2]) - 1]}`;
}

// The one line he reads first. Either half may be missing: a trip with a
// label but no date still says which session it is, and a date with no label
// still says when he teaches.
export function sessionLine(
  sessionLabel: string | null,
  sessionDate: string | null
): string {
  const label = (sessionLabel ?? "").trim();
  const day = shortDayLabel(sessionDate);
  if (label && day) return `${label} · ${day}`;
  return label || day;
}

// True when the travel span says something the session date does not, which
// is when showing both earns its space. A day return repeats itself, so it
// does not.
export function travelDiffersFromSession(
  start: string | null,
  end: string | null,
  sessionDate: string | null
): boolean {
  if (!sessionDate || !start) return true;
  return !(start === sessionDate && (end ?? start) === sessionDate);
}
