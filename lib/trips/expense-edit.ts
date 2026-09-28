// B22. One trip expense line changed by update_trip_expense, and the old
// values undo puts back. (Leg edits are lib/trips/legs.ts.)
//
// Pure (relative .ts only), so scripts/b22.test.ts proves the edit and its
// undo offline. The executor (lib/assistant/execute.ts) reads the row, calls
// these, writes through lib/trips/write.ts updateTripExpense (the function the
// trip screen's expense drawer uses), and keeps the old values on the
// assistant_actions row. trip_expenses has no description column, so there is
// no description to change.

import { EXPENSE_CATEGORIES, type ExpenseCategory } from "./core.ts";

const DATE = /^\d{4}-\d{2}-\d{2}$/;

export type EditResult<T> = { ok: true; value: T } | { ok: false; message: string };

// ---------------------------------------------------------------------------
// Expense lines
// ---------------------------------------------------------------------------

export interface ExpenseRow {
  category: ExpenseCategory;
  amount: number;
  date: string;
  billable: boolean;
  receipt_ref: string | null;
}

export const EXPENSE_EDIT_FIELDS = ["category", "amount", "date", "billable", "receipt_ref"] as const;

// What update_trip_expense may change, checked. Only keys present in the input
// are in the patch, so an omitted field is never touched. An empty
// receipt_ref string clears the reference.
export function expensePatch(input: Record<string, unknown>): EditResult<Partial<ExpenseRow>> {
  const patch: Partial<ExpenseRow> = {};
  if (input.category !== undefined && input.category !== null) {
    if (!EXPENSE_CATEGORIES.includes(input.category as ExpenseCategory)) {
      return { ok: false, message: `category must be one of ${EXPENSE_CATEGORIES.join(", ")}.` };
    }
    patch.category = input.category as ExpenseCategory;
  }
  if (input.amount !== undefined && input.amount !== null) {
    if (typeof input.amount !== "number" || !Number.isFinite(input.amount) || input.amount < 0) {
      return { ok: false, message: "amount must be a number of rupees, zero or more." };
    }
    patch.amount = input.amount;
  }
  if (input.date !== undefined && input.date !== null) {
    if (typeof input.date !== "string" || !DATE.test(input.date)) {
      return { ok: false, message: "date must be YYYY-MM-DD." };
    }
    patch.date = input.date;
  }
  if (typeof input.billable === "boolean") patch.billable = input.billable;
  if (typeof input.receipt_ref === "string") {
    // A reference string only, never the receipt itself.
    patch.receipt_ref = input.receipt_ref.trim().slice(0, 200) || null;
  }
  if (!Object.keys(patch).length) {
    return { ok: false, message: "Nothing to change: give at least one of category, amount, date, billable or receipt_ref." };
  }
  return { ok: true, value: patch };
}

// The old values of exactly the fields a patch touches, for undo.
export function expenseUndo(prev: ExpenseRow, patch: Partial<ExpenseRow>): Partial<ExpenseRow> {
  const out: Partial<ExpenseRow> = {};
  for (const k of EXPENSE_EDIT_FIELDS) {
    if (k in patch) (out as Record<string, unknown>)[k] = prev[k];
  }
  return out;
}

// What lifeos_list_trip_expenses hands back for each line.
export function expenseLine(e: {
  id: string;
  date: string;
  category: string;
  amount: number | string;
  billable: boolean;
  receipt_ref: string | null;
}) {
  return {
    id: e.id,
    date: e.date,
    category: e.category,
    amount: Number(e.amount),
    billable: e.billable,
    // A reference string, never the receipt itself.
    receipt_ref: e.receipt_ref,
    receipt_missing: e.billable && !(e.receipt_ref ?? "").trim(),
  };
}
