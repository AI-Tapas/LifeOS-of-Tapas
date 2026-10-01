"use client";

// B28. The journey page: one continuous trip serving several sessions. It
// shows every session, every leg in date order, and every expense of every
// session in one table, each marked "For" the session it belongs to. The
// "For" dropdown MOVES the expense (the whole of it: no splitting), and the
// connector's update_trip_expense does the same with undo.

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  BandHead,
  Card,
  Drawer,
  Field,
  btnSmall,
  drawerFooterCls,
  inputCls,
} from "@/components/ui";
import { formatINR } from "@/lib/datetime";
import {
  CATEGORY_LABELS,
  EXPENSE_CATEGORIES,
  MODE_LABELS,
  dayLabel,
  sessionLine,
  tripDatesLabel,
  type ExpenseCategory,
  type TripLeg,
} from "@/lib/trips/core";
import { PurposeChip, type TripPurpose } from "@/components/trips/bits";
import { BILLS_TO_LABELS, isReceiptGap, type BillsTo } from "@/lib/trips/month";
import { journeyCities, nearestSession, orderSessions } from "@/lib/trips/journey";
import { addExpenseAction, updateExpenseAction } from "@/app/(app)/trips/actions";

export interface JourneySessionRow {
  id: string;
  journey_id: string | null;
  purpose: TripPurpose;
  title: string;
  start_date: string | null;
  end_date: string | null;
  session_label: string | null;
  session_date: string | null;
  bills_to: BillsTo;
  cities: string[];
  legs: TripLeg[];
  stream_name: string;
}

interface JourneyExpense {
  id: string;
  trip_id: string;
  category: string;
  amount: number;
  date: string;
  billable: boolean;
  receipt_ref: string | null;
}

// "Cygnet, Bengaluru, 7 Oct": which session an option names.
function sessionName(s: JourneySessionRow): string {
  const place = s.cities.length ? s.cities.join(", ") : s.title;
  const day = sessionLine(s.session_label, s.session_date);
  return [s.stream_name, place, day].filter(Boolean).join(", ");
}

export default function JourneyView({
  sessions,
  expenses,
  todayKey,
}: {
  sessions: JourneySessionRow[];
  expenses: JourneyExpense[];
  todayKey: string;
}) {
  const router = useRouter();
  const [adding, setAdding] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const ordered = orderSessions(sessions);
  const cities = journeyCities(ordered);
  const starts = ordered.map((s) => s.start_date).filter((d): d is string => !!d);
  const ends = ordered.map((s) => s.end_date ?? s.start_date).filter((d): d is string => !!d);
  const first = starts.length ? starts.reduce((a, b) => (a < b ? a : b)) : null;
  const last = ends.length ? ends.reduce((a, b) => (a > b ? a : b)) : null;

  const legs = ordered
    .flatMap((s) => s.legs.map((l) => ({ ...l, session: s })))
    .sort((a, b) => a.date.localeCompare(b.date));
  const sorted = [...expenses].sort((a, b) => a.date.localeCompare(b.date));

  function moveTo(e: JourneyExpense, tripId: string) {
    if (tripId === e.trip_id) return;
    setErr(null);
    startTransition(async () => {
      const r = await updateExpenseAction(e.id, e.trip_id, { trip_id: tripId });
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
        <h1 className="text-xl font-semibold text-brand-deep">
          {cities.length ? cities.join(", ") : "Journey"}
        </h1>
        <p className="mt-0.5 text-sm text-secondary">
          {tripDatesLabel(first, last)} · {ordered.length} sessions
        </p>
      </div>

      {err && <p className="mt-3 text-sm text-overdue">{err}</p>}

      {/* --- sessions -------------------------------------------------- */}
      <section className="mt-5">
        <div className="mb-2">
          <BandHead title="Sessions" count={ordered.length} />
        </div>
        <div className="space-y-2">
          {ordered.map((s) => (
            <Link
              key={s.id}
              href={`/trips/${s.id}`}
              className="press block rounded-xl border border-border bg-surface p-3 shadow-[var(--shadow-card)]"
            >
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="truncate text-sm font-semibold">
                    {s.cities.length ? s.cities.join(", ") : s.title}
                    {s.stream_name ? (
                      <span className="font-normal text-secondary"> · {s.stream_name}</span>
                    ) : null}
                  </p>
                  <p className="mt-0.5 text-xs text-secondary">
                    {sessionLine(s.session_label, s.session_date) ||
                      tripDatesLabel(s.start_date, s.end_date)}
                    {" · "}
                    {BILLS_TO_LABELS[s.bills_to]}
                  </p>
                </div>
                <PurposeChip purpose={s.purpose} />
              </div>
            </Link>
          ))}
        </div>
      </section>

      {/* --- legs ------------------------------------------------------ */}
      <section className="mt-6">
        <div className="mb-2">
          <BandHead title="Legs" count={legs.length} />
        </div>
        {legs.length === 0 ? (
          <p className="text-sm text-secondary">No legs logged on any session yet.</p>
        ) : (
          <div className="space-y-2">
            {legs.map((l, i) => (
              <div
                key={`${l.session.id}-${l.date}-${i}`}
                className="flex items-start justify-between gap-2 rounded-xl border border-border bg-surface p-3 shadow-[var(--shadow-card)]"
              >
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">
                    {l.from || "?"} to {l.to || "?"}
                  </p>
                  <p className="mt-0.5 text-xs text-secondary">
                    {dayLabel(l.date) || "no date"} · {MODE_LABELS[l.mode]} · to{" "}
                    {l.session.stream_name || l.session.title}
                  </p>
                </div>
                <span className="shrink-0 text-sm">{l.cost != null ? formatINR(l.cost) : ""}</span>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* --- expenses -------------------------------------------------- */}
      <section className="mt-6">
        <div className="mb-2">
          <BandHead
            title="Expenses"
            count={sorted.length}
            action={
              <button onClick={() => setAdding(true)} className={btnSmall}>
                + Expense
              </button>
            }
          />
        </div>
        {sorted.length === 0 ? (
          <p className="text-sm text-secondary">
            No expenses on any session yet. An expense belongs to one session
            whole; it is never split.
          </p>
        ) : (
          <div className="space-y-2">
            {sorted.map((e) => (
              <Card key={e.id}>
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="text-sm">
                      {dayLabel(e.date)} ·{" "}
                      {CATEGORY_LABELS[e.category as ExpenseCategory] ?? e.category}
                    </p>
                    {e.receipt_ref ? (
                      <p className="mt-0.5 truncate text-xs text-muted">{e.receipt_ref}</p>
                    ) : (
                      isReceiptGap(e) && (
                        <p className="mt-0.5 text-xs font-semibold text-waiting">
                          no receipt reference
                        </p>
                      )
                    )}
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    <span className="rounded-full bg-surface-2 px-2.5 py-0.5 text-[11px] text-muted">
                      {e.billable ? "billable" : "own cost"}
                    </span>
                    <span className="text-sm font-medium">{formatINR(e.amount)}</span>
                  </div>
                </div>
                <label className="mt-2 flex items-center gap-2 text-xs text-secondary">
                  For
                  <select
                    value={e.trip_id}
                    disabled={pending}
                    onChange={(ev) => moveTo(e, ev.target.value)}
                    aria-label="For which session"
                    className={inputCls + " !py-1.5 text-sm"}
                  >
                    {ordered.map((s) => (
                      <option key={s.id} value={s.id}>
                        {sessionName(s)}
                      </option>
                    ))}
                  </select>
                </label>
              </Card>
            ))}
          </div>
        )}
        <p className="mt-2 text-[11px] text-muted">
          Records, not a claim. The month pack lists each claim from these
          rows: ICAI sessions on the ICAI pack, a client&apos;s reimbursable
          sessions on that client&apos;s pack.
        </p>
      </section>

      {adding && (
        <AddExpense
          sessions={ordered}
          defaultDate={todayKey}
          onClose={() => setAdding(false)}
        />
      )}
    </div>
  );
}

// "For which session?" with the session nearest the date preselected. The
// preselection follows the date until he picks a session himself.
function AddExpense({
  sessions,
  defaultDate,
  onClose,
}: {
  sessions: JourneySessionRow[];
  defaultDate: string;
  onClose: () => void;
}) {
  const router = useRouter();
  const first = sessions.find((s) => s.start_date) ?? sessions[0];
  const [date, setDate] = useState(first?.start_date ?? defaultDate);
  const [pick, setPick] = useState<string | null>(null);
  const forId = pick ?? nearestSession(sessions, date)?.id ?? sessions[0].id;
  const [category, setCategory] = useState<ExpenseCategory>("transport");
  const [amount, setAmount] = useState("");
  const [billable, setBillable] = useState(true);
  const [receiptRef, setReceiptRef] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function submit() {
    setErr(null);
    const n = Number(amount);
    if (!amount || !Number.isFinite(n)) {
      setErr("An amount is required.");
      return;
    }
    startTransition(async () => {
      const r = await addExpenseAction({
        trip_id: forId,
        category,
        amount: n,
        date,
        billable,
        receipt_ref: receiptRef.trim() || null,
      });
      if (r.ok) {
        onClose();
        router.refresh();
      } else {
        setErr(r.message);
      }
    });
  }

  return (
    <Drawer title="New expense" onClose={onClose}>
      <div className="space-y-3">
        <Field label="For which session?">
          <select value={forId} onChange={(e) => setPick(e.target.value)} className={inputCls}>
            {sessions.map((s) => (
              <option key={s.id} value={s.id}>
                {sessionName(s)}
              </option>
            ))}
          </select>
        </Field>
        <p className="-mt-1 text-[11px] text-secondary">
          The session nearest the date is chosen for you. A shared cost, such
          as the cab from home to the airport, goes whole to one session.
        </p>
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
          Billable, reimbursed by whoever that session bills
        </label>
        <Field label="Receipt reference">
          <input
            value={receiptRef}
            onChange={(e) => setReceiptRef(e.target.value)}
            className={inputCls}
            placeholder="e.g. physical file, October folder"
          />
        </Field>
        {err && <p className="text-sm text-overdue">{err}</p>}
        <div className={drawerFooterCls + " flex gap-2"}>
          <button
            onClick={submit}
            disabled={pending}
            className="press flex-1 rounded-lg bg-accent px-3 py-2 text-sm font-medium text-white disabled:opacity-50 dark:text-neutral-950"
          >
            {pending ? "Saving" : "Add"}
          </button>
        </div>
      </div>
    </Drawer>
  );
}
