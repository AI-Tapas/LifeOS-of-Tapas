"use client";

// One trip: its legs, its expenses grouped by category, and the bills built
// from it. Everything a claim needs sits on this screen; the print view is
// one tap away once a bill exists.

import { useMemo, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  BandHead,
  Card,
  Drawer,
  Empty,
  Field,
  PageHeader,
  SectionLabel,
  btnSmall,
  drawerFooterCls,
  inputCls,
} from "@/components/ui";
import { formatDateIST, formatINR } from "@/lib/datetime";
import {
  CATEGORY_LABELS,
  EXPENSE_CATEGORIES,
  MODE_LABELS,
  TRANSPORT_HELP,
  TRANSPORT_MODES,
  billableTotal,
  dayLabel,
  tripDatesLabel,
  type ExpenseCategory,
  type TransportMode,
  type TripLeg,
} from "@/lib/trips/bill";
import {
  PurposeChip,
  StatusTrail,
  type TripStatus,
} from "@/components/trips/bits";
import TripForm, {
  type TripFormValues,
  type WorkStreamRow,
} from "@/components/trips/trip-form";
import BillBuilder from "@/components/trips/bill-builder";
import { setTaskStatusAction } from "@/app/(app)/tasks/actions";
import {
  addChecklistAction,
  addExpenseAction,
  deleteExpenseAction,
  setBillStatusAction,
  updateExpenseAction,
  updateTripAction,
} from "@/app/(app)/trips/actions";
import type { Database } from "@/lib/database.types";

type BillStatus = Database["public"]["Enums"]["bill_status"];
type BillRecipient = Database["public"]["Enums"]["bill_recipient"];

export interface ExpenseRow {
  id: string;
  category: ExpenseCategory;
  amount: number;
  date: string;
  billable: boolean;
  receipt_ref: string | null;
}

// A checklist step: an ordinary task carrying this trip's id, shown here so
// travel admin has one home instead of five rows in the task list.
export interface ChecklistRow {
  id: string;
  title: string;
  notes: string | null;
  status: "inbox" | "todo" | "doing" | "done" | "dropped";
  due_ts: string | null;
}

export interface BillSummary {
  id: string;
  number: string;
  date: string;
  bill_to: BillRecipient;
  amount: number;
  status: BillStatus;
}

export default function TripDetail({
  trip,
  streamName,
  legs,
  checklist,
  expenses,
  bills,
  workStreams,
  suggestedNumber,
  todayKey,
}: {
  trip: TripFormValues;
  streamName: string;
  legs: TripLeg[];
  checklist: ChecklistRow[];
  expenses: ExpenseRow[];
  bills: BillSummary[];
  workStreams: WorkStreamRow[];
  suggestedNumber: string;
  todayKey: string;
}) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [legEditing, setLegEditing] = useState<{ index: number } | "new" | null>(null);
  const [expenseEditing, setExpenseEditing] = useState<ExpenseRow | "new" | null>(null);
  const [building, setBuilding] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const claimable = billableTotal(expenses);
  const ownCost = expenses
    .filter((e) => !e.billable)
    .reduce((sum, e) => sum + e.amount, 0);

  const byCategory = useMemo(
    () =>
      EXPENSE_CATEGORIES.map((c) => ({
        category: c,
        items: expenses.filter((e) => e.category === c),
      })).filter((g) => g.items.length > 0),
    [expenses]
  );

  function setStatus(next: TripStatus) {
    startTransition(async () => {
      const r = await updateTripAction(trip.id!, { status: next });
      if (!r.ok) setErr(r.message);
      router.refresh();
    });
  }

  function saveLegs(next: TripLeg[]) {
    startTransition(async () => {
      const r = await updateTripAction(trip.id!, { legs: next });
      if (!r.ok) setErr(r.message);
      setLegEditing(null);
      router.refresh();
    });
  }

  function billStatus(bill: BillSummary, next: BillStatus) {
    startTransition(async () => {
      const r = await setBillStatusAction(bill.id, trip.id!, next);
      if (!r.ok) setErr(r.message);
      router.refresh();
    });
  }

  return (
    <div>
      <Link href="/trips" className="text-xs font-semibold text-secondary">
        Back to trips
      </Link>

      <div className="mt-2">
        <PageHeader
          title={trip.title}
          subtitle={`${tripDatesLabel(trip.start_date, trip.end_date)}${
            streamName ? ` · ${streamName}` : ""
          }`}
          action={
            <button onClick={() => setEditing(true)} className={btnSmall}>
              Edit
            </button>
          }
        />
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <PurposeChip purpose={trip.purpose} />
        {trip.cities.length > 0 && (
          <span className="text-xs text-secondary">{trip.cities.join(", ")}</span>
        )}
      </div>

      <div className="mt-3">
        <StatusTrail status={trip.status} onPick={setStatus} disabled={pending} />
      </div>

      {err && <p className="mt-3 text-sm text-overdue">{err}</p>}

      {trip.purpose === "aica" && (
        <p className="mt-3 rounded-xl border border-brand/30 bg-brand-soft p-3 text-xs text-brand-deep">
          AICA: arrive the night before the session. The branch arranges the
          hotel, so plan transport only. {TRANSPORT_HELP}
        </p>
      )}

      {trip.notes && (
        <p className="mt-3 whitespace-pre-wrap text-sm text-secondary">{trip.notes}</p>
      )}

      {/* --- legs ----------------------------------------------------- */}
      <section className="mt-6">
        <div className="mb-2">
          <BandHead
            title="Legs"
            action={
              <button onClick={() => setLegEditing("new")} className={btnSmall}>
                + Leg
              </button>
            }
          />
        </div>
        {legs.length === 0 ? (
          <Empty title="No legs yet.">
            Add the journeys: from, to, date and mode. {TRANSPORT_HELP}
          </Empty>
        ) : (
          <div className="space-y-2">
            {legs.map((leg, i) => (
              <button
                key={`${leg.date}-${i}`}
                onClick={() => setLegEditing({ index: i })}
                className="press flex w-full items-start justify-between gap-2 rounded-xl border border-border bg-surface p-3 text-left shadow-[var(--shadow-card)]"
              >
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">
                    {leg.from || "?"} to {leg.to || "?"}
                  </p>
                  <p className="mt-0.5 text-xs text-secondary">
                    {dayLabel(leg.date) || "no date"} · {MODE_LABELS[leg.mode]}
                  </p>
                </div>
                <span className="shrink-0 text-sm">
                  {leg.cost != null ? formatINR(leg.cost) : ""}
                </span>
              </button>
            ))}
          </div>
        )}
      </section>

      {/* --- checklist ------------------------------------------------- */}
      <Checklist trip={trip} items={checklist} onError={setErr} />

      {/* --- expenses -------------------------------------------------- */}
      <section className="mt-6">
        <div className="mb-2">
          <BandHead
            title="Expenses"
            action={
              <button onClick={() => setExpenseEditing("new")} className={btnSmall}>
                + Expense
              </button>
            }
          />
        </div>
        {expenses.length === 0 ? (
          <Empty title="No expenses yet.">
            Log what the trip cost. Mark the ones the institute reimburses as
            billable; those become the bill.
          </Empty>
        ) : (
          <div className="space-y-4">
            {byCategory.map((g) => (
              <div key={g.category}>
                <SectionLabel className="mb-1.5">
                  {CATEGORY_LABELS[g.category]}
                </SectionLabel>
                <div className="space-y-2">
                  {g.items.map((e) => (
                    <button
                      key={e.id}
                      onClick={() => setExpenseEditing(e)}
                      className="press flex w-full items-start justify-between gap-2 rounded-xl border border-border bg-surface p-3 text-left shadow-[var(--shadow-card)]"
                    >
                      <div className="min-w-0">
                        <p className="text-sm">{dayLabel(e.date)}</p>
                        {e.receipt_ref && (
                          <p className="mt-0.5 truncate text-xs text-muted">
                            {e.receipt_ref}
                          </p>
                        )}
                      </div>
                      <div className="flex shrink-0 items-center gap-2">
                        {e.billable ? (
                          <span className="rounded-full bg-ok-soft px-2.5 py-0.5 text-[11px] font-semibold text-ok">
                            billable
                          </span>
                        ) : (
                          <span className="rounded-full bg-surface-2 px-2.5 py-0.5 text-[11px] text-muted">
                            own cost
                          </span>
                        )}
                        <span className="text-sm font-medium">{formatINR(e.amount)}</span>
                      </div>
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}

        {expenses.length > 0 && (
          <Card className="mt-3">
            <div className="flex items-baseline justify-between">
              <span className="text-sm text-secondary">Billable</span>
              <span className="text-lg font-semibold">{formatINR(claimable)}</span>
            </div>
            <div className="mt-1 flex items-baseline justify-between">
              <span className="text-sm text-secondary">Own cost</span>
              <span className="text-sm">{formatINR(ownCost)}</span>
            </div>
          </Card>
        )}
      </section>

      {/* --- bills ------------------------------------------------------ */}
      <section className="mt-6">
        <div className="mb-2">
          <BandHead
            title="Bills"
            action={
              <button
                onClick={() => setBuilding(true)}
                disabled={claimable <= 0}
                className={btnSmall + " disabled:opacity-40"}
              >
                Build bill
              </button>
            }
          />
        </div>
        {bills.length === 0 ? (
          <Empty title="No bill yet.">
            {claimable > 0
              ? "Build bill drafts the line items from the billable expenses. You can edit every line before saving."
              : "Mark an expense billable and the bill builder opens."}
          </Empty>
        ) : (
          <div className="space-y-2">
            {bills.map((b) => (
              <Card key={b.id}>
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="truncate font-medium">{b.number}</p>
                    <p className="mt-0.5 text-xs text-secondary">
                      {dayLabel(b.date)} · to the {b.bill_to}
                    </p>
                  </div>
                  <span className="shrink-0 text-sm font-semibold">
                    {formatINR(b.amount)}
                  </span>
                </div>
                <div className="mt-2.5 flex flex-wrap items-center gap-2">
                  <span
                    className={
                      "rounded-full px-2.5 py-0.5 text-[11px] font-semibold " +
                      (b.status === "paid"
                        ? "bg-ok-soft text-ok"
                        : b.status === "sent"
                          ? "bg-waiting-soft text-waiting"
                          : "bg-surface-2 text-secondary")
                    }
                  >
                    {b.status}
                  </span>
                  <Link href={`/trips/bill/${b.id}`} className={btnSmall + " py-2"}>
                    Open and print
                  </Link>
                  {b.status === "draft" && (
                    <button
                      onClick={() => billStatus(b, "sent")}
                      disabled={pending}
                      className={btnSmall}
                    >
                      Mark sent
                    </button>
                  )}
                  {b.status === "sent" && (
                    <button
                      onClick={() => billStatus(b, "paid")}
                      disabled={pending}
                      className={btnSmall}
                    >
                      Mark paid
                    </button>
                  )}
                </div>
                <p className="mt-2 text-[11px] text-muted">
                  The app never sends a bill. Sending it, and saying it was
                  sent, stays with you.
                </p>
              </Card>
            ))}
          </div>
        )}
      </section>

      {editing && (
        <TripForm
          trip={trip}
          workStreams={workStreams}
          onClose={() => setEditing(false)}
          onDeleted={() => router.push("/trips")}
        />
      )}

      {legEditing && (
        <LegForm
          leg={legEditing === "new" ? null : legs[legEditing.index]}
          defaultDate={trip.start_date ?? todayKey}
          pending={pending}
          onSave={(leg) =>
            saveLegs(
              legEditing === "new"
                ? [...legs, leg]
                : legs.map((l, i) => (i === legEditing.index ? leg : l))
            )
          }
          onDelete={
            legEditing === "new"
              ? undefined
              : () => saveLegs(legs.filter((_, i) => i !== legEditing.index))
          }
          onClose={() => setLegEditing(null)}
        />
      )}

      {expenseEditing && (
        <ExpenseForm
          expense={expenseEditing === "new" ? null : expenseEditing}
          tripId={trip.id!}
          defaultDate={trip.start_date ?? todayKey}
          onClose={() => setExpenseEditing(null)}
        />
      )}

      {building && (
        <BillBuilder
          tripId={trip.id!}
          expenses={expenses}
          suggestedNumber={suggestedNumber}
          defaultDate={todayKey}
          defaultAddress={trip.billable_to ?? ""}
          onClose={() => setBuilding(false)}
        />
      )}
    </div>
  );
}

// --- leg drawer -------------------------------------------------------------
function LegForm({
  leg,
  defaultDate,
  pending,
  onSave,
  onDelete,
  onClose,
}: {
  leg: TripLeg | null;
  defaultDate: string;
  pending: boolean;
  onSave: (leg: TripLeg) => void;
  onDelete?: () => void;
  onClose: () => void;
}) {
  const [from, setFrom] = useState(leg?.from ?? "");
  const [to, setTo] = useState(leg?.to ?? "");
  const [date, setDate] = useState(leg?.date ?? defaultDate);
  const [mode, setMode] = useState<TransportMode>(leg?.mode ?? "vande_bharat");
  const [cost, setCost] = useState(leg?.cost != null ? String(leg.cost) : "");
  const [armed, setArmed] = useState(false);

  return (
    <Drawer title={leg ? "Edit leg" : "New leg"} onClose={onClose}>
      <div className="space-y-3">
        <div className="flex gap-2">
          <Field label="From">
            <input
              value={from}
              onChange={(e) => setFrom(e.target.value)}
              className={inputCls}
              placeholder="Ahmedabad"
            />
          </Field>
          <Field label="To">
            <input
              value={to}
              onChange={(e) => setTo(e.target.value)}
              className={inputCls}
              placeholder="Rajkot"
            />
          </Field>
        </div>
        <Field label="Date">
          <input
            type="date"
            value={date}
            onChange={(e) => setDate(e.target.value)}
            className={inputCls}
          />
        </Field>
        <Field label="Mode">
          <select
            value={mode}
            onChange={(e) => setMode(e.target.value as TransportMode)}
            className={inputCls}
          >
            {/* Listed best first, his own order. */}
            {TRANSPORT_MODES.map((m) => (
              <option key={m} value={m}>
                {MODE_LABELS[m]}
              </option>
            ))}
          </select>
        </Field>
        <p className="text-xs text-secondary">{TRANSPORT_HELP}</p>
        <Field label="Cost (₹)">
          <input
            type="number"
            inputMode="decimal"
            value={cost}
            onChange={(e) => setCost(e.target.value)}
            className={inputCls}
          />
        </Field>

        <div className={drawerFooterCls + " flex gap-2"}>
          <button
            onClick={() =>
              onSave({
                from: from.trim(),
                to: to.trim(),
                date,
                mode,
                cost: cost ? Number(cost) : null,
              })
            }
            disabled={pending}
            className="press flex-1 rounded-lg bg-accent px-3 py-2 text-sm font-medium text-white disabled:opacity-50 dark:text-neutral-950"
          >
            {pending ? "Saving" : "Save"}
          </button>
          {onDelete && (
            <button
              onClick={() => (armed ? onDelete() : setArmed(true))}
              disabled={pending}
              className={
                armed
                  ? "press rounded-lg bg-red-600 px-3 py-2 text-sm font-medium text-white disabled:opacity-50"
                  : "press rounded-lg border border-border-strong px-3 py-2 text-sm text-overdue disabled:opacity-50"
              }
            >
              {armed ? "Confirm delete" : "Delete"}
            </button>
          )}
        </div>
      </div>
    </Drawer>
  );
}

// --- expense drawer ---------------------------------------------------------
function ExpenseForm({
  expense,
  tripId,
  defaultDate,
  onClose,
}: {
  expense: ExpenseRow | null;
  tripId: string;
  defaultDate: string;
  onClose: () => void;
}) {
  const router = useRouter();
  const [category, setCategory] = useState<ExpenseCategory>(
    expense?.category ?? "transport"
  );
  const [amount, setAmount] = useState(expense ? String(expense.amount) : "");
  const [date, setDate] = useState(expense?.date ?? defaultDate);
  const [billable, setBillable] = useState(expense?.billable ?? true);
  const [receiptRef, setReceiptRef] = useState(expense?.receipt_ref ?? "");
  const [err, setErr] = useState<string | null>(null);
  const [armed, setArmed] = useState(false);
  const [pending, startTransition] = useTransition();

  function submit() {
    setErr(null);
    setArmed(false);
    const patch = {
      category,
      amount: Number(amount),
      date,
      billable,
      receipt_ref: receiptRef.trim() || null,
    };
    if (!Number.isFinite(patch.amount)) {
      setErr("An amount is required.");
      return;
    }
    startTransition(async () => {
      const r = expense
        ? await updateExpenseAction(expense.id, tripId, patch)
        : await addExpenseAction({ trip_id: tripId, ...patch });
      if (r.ok) {
        onClose();
        router.refresh();
      } else {
        setErr(r.message);
      }
    });
  }

  function remove() {
    if (!expense) return;
    if (!armed) {
      setArmed(true);
      return;
    }
    startTransition(async () => {
      await deleteExpenseAction(expense.id, tripId);
      onClose();
      router.refresh();
    });
  }

  return (
    <Drawer title={expense ? "Edit expense" : "New expense"} onClose={onClose}>
      <div className="space-y-3">
        <Field label="Category">
          <select
            value={category}
            onChange={(e) => setCategory(e.target.value as ExpenseCategory)}
            className={inputCls}
          >
            {EXPENSE_CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {CATEGORY_LABELS[c]}
              </option>
            ))}
          </select>
        </Field>
        <div className="flex gap-2">
          <Field label="Amount (₹)">
            <input
              type="number"
              inputMode="decimal"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              className={inputCls}
            />
          </Field>
          <Field label="Date">
            <input
              type="date"
              value={date}
              onChange={(e) => setDate(e.target.value)}
              className={inputCls}
            />
          </Field>
        </div>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={billable}
            onChange={(e) => setBillable(e.target.checked)}
          />
          Billable, goes on the reimbursement bill
        </label>
        <Field label="Receipt reference">
          <input
            value={receiptRef}
            onChange={(e) => setReceiptRef(e.target.value)}
            className={inputCls}
            placeholder="e.g. physical file, May folder"
          />
        </Field>
        <p className="text-xs text-muted">
          A note about where the receipt lives, not the receipt itself. The app
          never stores documents.
        </p>

        {err && <p className="text-sm text-overdue">{err}</p>}

        <div className={drawerFooterCls + " flex gap-2"}>
          <button
            onClick={submit}
            disabled={pending}
            className="press flex-1 rounded-lg bg-accent px-3 py-2 text-sm font-medium text-white disabled:opacity-50 dark:text-neutral-950"
          >
            {pending ? "Saving" : expense ? "Save" : "Add"}
          </button>
          {expense && (
            <button
              onClick={remove}
              disabled={pending}
              className={
                armed
                  ? "press rounded-lg bg-red-600 px-3 py-2 text-sm font-medium text-white disabled:opacity-50"
                  : "press rounded-lg border border-border-strong px-3 py-2 text-sm text-overdue disabled:opacity-50"
              }
            >
              {armed ? "Confirm delete" : "Delete"}
            </button>
          )}
        </div>
      </div>
    </Drawer>
  );
}

// One trip's checklist. The steps are ordinary tasks (same due dates, same
// Google Calendar reminders, same one-tap completion as anywhere else); they
// simply live here instead of flooding the task list.
function Checklist({
  trip,
  items,
  onError,
}: {
  trip: TripFormValues;
  items: ChecklistRow[];
  onError: (m: string | null) => void;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const live = items.filter((i) => i.status !== "dropped");
  const done = live.filter((i) => i.status === "done").length;

  function complete(id: string) {
    startTransition(async () => {
      const r = await setTaskStatusAction(id, "done");
      if (!r.ok) onError(r.message ?? "Could not complete the step.");
      router.refresh();
    });
  }

  function seed() {
    startTransition(async () => {
      const r = await addChecklistAction(trip.id!);
      if (!r.ok) onError(r.message);
      router.refresh();
    });
  }

  return (
    <section className="mt-6">
      <div className="mb-2">
        <BandHead
          title="Checklist"
          action={
            live.length > 0 ? (
              <span className="text-[11px] font-bold text-muted">
                {done} of {live.length} done
              </span>
            ) : undefined
          }
        />
      </div>
      {live.length === 0 ? (
        <Empty title="No checklist yet.">
          The standard travel checklist is five steps: book onward, book
          return, confirm the hotel, collect the receipts, build the bill. Each
          becomes a task dated from this trip, with its own reminder.
          <span className="mt-3 block">
            <button onClick={seed} disabled={pending} className={btnSmall}>
              {pending ? "Adding" : "Add the standard checklist"}
            </button>
          </span>
        </Empty>
      ) : (
        <div className="space-y-2">
          {live.map((step) => {
            const isDone = step.status === "done";
            return (
              <div
                key={step.id}
                className="flex items-center gap-1 rounded-lg border border-border bg-surface p-1.5 shadow-[var(--shadow-card)]"
              >
                <button
                  onClick={() => complete(step.id)}
                  disabled={pending || isDone}
                  aria-label={`Mark done: ${step.title}`}
                  className="press flex h-11 w-11 shrink-0 items-center justify-center rounded-full disabled:opacity-60"
                >
                  <span
                    className={
                      "h-5 w-5 rounded-full border-2 " +
                      (isDone ? "border-ok bg-ok" : "border-border-strong")
                    }
                  />
                </button>
                <div className="min-w-0 flex-1 py-1.5">
                  <p
                    className={
                      "truncate text-sm " + (isDone ? "text-neutral-400 line-through" : "")
                    }
                  >
                    {step.title}
                  </p>
                  {step.due_ts && (
                    <p className="mt-0.5 text-[11px] text-neutral-500">
                      due {formatDateIST(step.due_ts)}
                    </p>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
