// The month pack: what Tapas's invoice run needs from Life OS, and nothing
// more. It is a handover, not an invoice.
//
// His invoicing already works and is more careful than anything worth
// rebuilding: a formula-driven workbook on his own machine, filled by
// scripts, signed with his DSC, mirrored into Zoho Books, numbered from one
// continuous series across all his clients. So this file computes no invoice
// number, no professional fee, no claim total, and produces no PDF. It
// gathers the month's sessions, travel legs and expenses, says plainly which
// trips are excluded and why, and lists the receipts still missing.
//
// Two rules that belong to his invoice process and are deliberately NOT
// applied here: overseas rows are handled by the exclusion below and nothing
// more, and industry sessions are relabelled on the invoice itself. Record
// what a trip actually is; let the invoice run do the formatting.
//
// Pure and dependency-free (only the shared date helpers), so
// scripts/m6.test.ts proves it offline.

import { addMonths, civilKey, formatMonthYear, type CivilDate } from "../datetime.ts";
import {
  CATEGORY_LABELS,
  dayLabel,
  parseLegs,
  tripDatesLabel,
  type ExpenseCategory,
  type TripLeg,
} from "./core.ts";

// trip_bills_to. Kept as a plain union so this file stays importable by
// node --test without the generated database types.
export type BillsTo = "icai_monthly" | "chapter_aed" | "none";

export const BILLS_TO_VALUES: BillsTo[] = ["icai_monthly", "chapter_aed", "none"];

export const BILLS_TO_LABELS: Record<BillsTo, string> = {
  icai_monthly: "Monthly ICAI claim",
  chapter_aed: "Overseas chapter, AED",
  none: "Not billable",
};

export const BILLS_TO_HELP: Record<BillsTo, string> = {
  icai_monthly: "Goes into the monthly claim to the ICAI AI committee.",
  chapter_aed:
    "Invoiced separately to the chapter, in AED. Never on the ICAI invoice.",
  none: "Nobody reimburses this one.",
};

export interface MonthTrip {
  id: string;
  title: string;
  start_date: string | null;
  end_date: string | null;
  cities: string[];
  bills_to: BillsTo;
  legs: unknown; // jsonb, read through parseLegs
}

export interface MonthExpense {
  id: string;
  trip_id: string;
  category: string;
  amount: number;
  date: string; // YYYY-MM-DD
  billable: boolean;
  receipt_ref: string | null;
}

// ---------------------------------------------------------------------------
// Month selection
// ---------------------------------------------------------------------------
// A trip belongs to the month it FINISHES in. start_date and end_date are
// bare calendar dates written in IST, never timestamps, so a session ending
// 31 August at 11 pm IST is stored as 2026-08-31 and lands in August with no
// timezone arithmetic to get wrong. This is the whole month-boundary rule.
export function tripMonthKey(trip: {
  start_date: string | null;
  end_date: string | null;
}): string {
  const last = trip.end_date ?? trip.start_date;
  return last ? last.slice(0, 7) : "";
}

// "2026-08" as "August 2026".
export function monthLabel(monthKey: string): string {
  if (!/^\d{4}-\d{2}$/.test(monthKey)) return "No month";
  return formatMonthYear({
    y: Number(monthKey.slice(0, 4)),
    m: Number(monthKey.slice(5, 7)),
    d: 1,
  });
}

export function shiftMonth(monthKey: string, months: number): string {
  const c: CivilDate = {
    y: Number(monthKey.slice(0, 4)),
    m: Number(monthKey.slice(5, 7)),
    d: 1,
  };
  return civilKey(addMonths(c, months)).slice(0, 7);
}

// The month the pack defaults to: the one just gone, since that is the one he
// invoices. todayKey is an IST calendar date, YYYY-MM-DD.
export function previousMonthKey(todayKey: string): string {
  return shiftMonth(todayKey.slice(0, 7), -1);
}

// ---------------------------------------------------------------------------
// Receipt gaps
// ---------------------------------------------------------------------------
// A billable expense with no receipt reference becomes a chase at invoice
// time. Surfacing it while the month is still running is the point.
export function isReceiptGap(e: MonthExpense): boolean {
  return e.billable && !(e.receipt_ref ?? "").trim();
}

export function receiptGaps(
  expenses: MonthExpense[],
  monthKeys: string[]
): MonthExpense[] {
  const wanted = new Set(monthKeys);
  return expenses
    .filter((e) => isReceiptGap(e) && wanted.has(e.date.slice(0, 7)))
    .sort((a, b) => a.date.localeCompare(b.date));
}

// The two months a gap can still be fixed cheaply in: the one running and the
// one just gone.
export function currentAndPreviousMonths(todayKey: string): string[] {
  const m = todayKey.slice(0, 7);
  return [m, shiftMonth(m, -1)];
}

// The morning brief carries this line from the 25th of the month onward only.
// Running it all month turns it into wallpaper.
export const GAP_LINE_FROM_DAY = 25;

// trip_expenses.category as he reads it ("Per diem", not "per_diem"). Falls
// back to the raw value so a category added later still shows something.
export function categoryLabel(category: string): string {
  return CATEGORY_LABELS[category as ExpenseCategory] ?? category;
}

export function briefGapLine(
  expenses: MonthExpense[],
  todayKey: string
): string | null {
  if (Number(todayKey.slice(8, 10)) < GAP_LINE_FROM_DAY) return null;
  const n = receiptGaps(expenses, currentAndPreviousMonths(todayKey)).length;
  if (!n) return null;
  return `${n} billable ${n === 1 ? "expense has" : "expenses have"} no receipt reference yet. The invoice run needs them.`;
}

// ---------------------------------------------------------------------------
// The pack
// ---------------------------------------------------------------------------
export interface MonthSession {
  trip_id: string;
  title: string;
  cities: string[];
  dates: string;
  start_date: string | null;
  end_date: string | null;
}

export interface MonthLegRow extends TripLeg {
  trip_id: string;
}

export interface MonthExpenseGroup {
  trip_id: string;
  title: string;
  cities: string[];
  expenses: MonthExpense[];
}

export interface MonthExclusion {
  trip_id: string;
  title: string;
  cities: string[];
  dates: string;
  bills_to: Exclude<BillsTo, "icai_monthly">;
  reason: string;
}

export interface MonthPack {
  month_key: string;
  month_label: string;
  sessions: MonthSession[];
  legs: MonthLegRow[];
  expense_groups: MonthExpenseGroup[];
  excluded: MonthExclusion[];
  gaps: MonthExpense[];
}

export function buildMonthPack(
  trips: MonthTrip[],
  expenses: MonthExpense[],
  monthKey: string
): MonthPack {
  const inMonth = trips
    .filter((t) => tripMonthKey(t) === monthKey)
    .sort((a, b) => (a.start_date ?? "").localeCompare(b.start_date ?? ""));
  const claimed = inMonth.filter((t) => t.bills_to === "icai_monthly");
  const claimedIds = new Set(claimed.map((t) => t.id));

  const sessions: MonthSession[] = claimed.map((t) => ({
    trip_id: t.id,
    title: t.title,
    cities: t.cities,
    dates: tripDatesLabel(t.start_date, t.end_date),
    start_date: t.start_date,
    end_date: t.end_date,
  }));

  const legs: MonthLegRow[] = claimed
    .flatMap((t) => parseLegs(t.legs).map((l) => ({ ...l, trip_id: t.id })))
    .sort((a, b) => a.date.localeCompare(b.date));

  const expense_groups: MonthExpenseGroup[] = claimed
    .map((t) => ({
      trip_id: t.id,
      title: t.title,
      cities: t.cities,
      expenses: expenses
        .filter((e) => e.trip_id === t.id)
        .sort((a, b) => a.date.localeCompare(b.date)),
    }))
    .filter((g) => g.expenses.length > 0);

  const excluded: MonthExclusion[] = inMonth
    .filter((t) => t.bills_to !== "icai_monthly")
    .map((t) => ({
      trip_id: t.id,
      title: t.title,
      cities: t.cities,
      dates: tripDatesLabel(t.start_date, t.end_date),
      bills_to: t.bills_to as Exclude<BillsTo, "icai_monthly">,
      reason:
        t.bills_to === "chapter_aed"
          ? "Bills to the chapter in AED, on its own invoice. Not on the ICAI claim."
          : "Not billable to anyone.",
    }));

  const gaps = expenses
    .filter((e) => claimedIds.has(e.trip_id) && isReceiptGap(e))
    .sort((a, b) => a.date.localeCompare(b.date));

  return {
    month_key: monthKey,
    month_label: monthLabel(monthKey),
    sessions,
    legs,
    expense_groups,
    excluded,
    gaps,
  };
}

// ---------------------------------------------------------------------------
// Plain text for the clipboard
// ---------------------------------------------------------------------------
// Pasted into the session that builds the workbook. That is the entire
// integration: no invoice number, no fee computation, no Zoho call. Money is
// written as bare digits so a spreadsheet reads them as numbers.
export function monthPackText(pack: MonthPack): string {
  const lines: string[] = [
    `Life OS month pack: ${pack.month_label}`,
    "Records only. No invoice number, no fee, no totals: the workbook computes those.",
    "",
    "SESSIONS (monthly ICAI claim)",
  ];

  if (pack.sessions.length) {
    for (const s of pack.sessions) {
      lines.push(
        `- ${s.dates} | ${s.cities.join(", ") || "no city recorded"} | ${s.title}`
      );
    }
  } else {
    lines.push("- none");
  }

  lines.push("", "TRAVEL LEGS");
  if (pack.legs.length) {
    for (const l of pack.legs) {
      lines.push(
        `- ${dayLabel(l.date)} | ${l.from || "?"} to ${l.to || "?"} | ${l.mode} | ${
          l.cost != null ? l.cost : "cost not recorded"
        }`
      );
    }
  } else {
    lines.push("- none");
  }

  lines.push("", "EXPENSES");
  if (pack.expense_groups.length) {
    for (const g of pack.expense_groups) {
      lines.push(`${g.title}${g.cities.length ? ` (${g.cities.join(", ")})` : ""}`);
      for (const e of g.expenses) {
        lines.push(
          `- ${dayLabel(e.date)} | ${categoryLabel(e.category)} | ${e.amount} | ${
            (e.receipt_ref ?? "").trim() || "no receipt on file"
          }${e.billable ? "" : " | own cost, not claimed"}`
        );
      }
      lines.push("");
    }
  } else {
    lines.push("- none", "");
  }

  lines.push("EXCLUDED FROM THIS CLAIM");
  if (pack.excluded.length) {
    for (const x of pack.excluded) {
      lines.push(
        `- ${x.dates} | ${x.cities.join(", ") || "no city recorded"} | ${x.title} | ${x.reason}`
      );
    }
  } else {
    lines.push("- none");
  }

  lines.push("", "GAPS: billable expenses with no receipt reference");
  if (pack.gaps.length) {
    pack.gaps.forEach((e, i) => {
      const group = pack.expense_groups.find((g) => g.trip_id === e.trip_id);
      lines.push(
        `${i + 1}. ${dayLabel(e.date)} | ${categoryLabel(e.category)} | ${e.amount} | ${
          group?.title ?? "trip"
        }`
      );
    });
  } else {
    lines.push("None. Every billable expense has a reference.");
  }

  return lines.join("\n");
}
