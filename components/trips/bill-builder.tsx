"use client";

// Bill builder. It drafts line items from the trip's billable expenses,
// grouped by category, and then gets out of the way: every field is editable
// before saving. Saving writes a bills row with status draft. Nothing is sent
// to anybody from here, now or later.

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Drawer, Field, drawerFooterCls, inputCls } from "@/components/ui";
import { formatINR } from "@/lib/datetime";
import {
  amountInWordsIndian,
  deriveLineItems,
  lineItemsTotal,
  type BillLineItem,
  type BillableExpense,
} from "@/lib/trips/bill";
import { createBillAction } from "@/app/(app)/trips/actions";
import type { Database } from "@/lib/database.types";

type BillRecipient = Database["public"]["Enums"]["bill_recipient"];

const RECIPIENTS: BillRecipient[] = ["institute", "client", "other"];

export default function BillBuilder({
  tripId,
  expenses,
  suggestedNumber,
  defaultDate,
  defaultAddress,
  onClose,
}: {
  tripId: string;
  expenses: BillableExpense[];
  suggestedNumber: string;
  defaultDate: string;
  defaultAddress: string;
  onClose: () => void;
}) {
  const router = useRouter();
  const [items, setItems] = useState<BillLineItem[]>(() => deriveLineItems(expenses));
  const [number, setNumber] = useState(suggestedNumber);
  const [date, setDate] = useState(defaultDate);
  const [billTo, setBillTo] = useState<BillRecipient>("institute");
  const [address, setAddress] = useState(defaultAddress);
  const [err, setErr] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const total = lineItemsTotal(items);

  function patch(index: number, change: Partial<BillLineItem>) {
    setItems(items.map((it, i) => (i === index ? { ...it, ...change } : it)));
  }

  function submit() {
    setErr(null);
    const clean = items.filter((i) => i.description.trim() && i.amount !== 0);
    if (!clean.length) {
      setErr("A bill needs at least one line.");
      return;
    }
    if (!number.trim()) {
      setErr("A bill number is required.");
      return;
    }
    startTransition(async () => {
      const r = await createBillAction({
        trip_id: tripId,
        bill_to: billTo,
        bill_to_address: address.trim() || null,
        number: number.trim(),
        date,
        line_items: clean,
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
    <Drawer title="Build bill" onClose={onClose}>
      <div className="space-y-3">
        <div className="flex gap-2">
          <Field label="Bill number">
            <input
              value={number}
              onChange={(e) => setNumber(e.target.value)}
              className={inputCls}
            />
          </Field>
          <Field label="Bill date">
            <input
              type="date"
              value={date}
              onChange={(e) => setDate(e.target.value)}
              className={inputCls}
            />
          </Field>
        </div>
        <p className="text-xs text-muted">
          Suggested as the next number in the financial year. Change it if your
          series says otherwise.
        </p>

        <Field label="Bill to">
          <select
            value={billTo}
            onChange={(e) => setBillTo(e.target.value as BillRecipient)}
            className={inputCls}
          >
            {RECIPIENTS.map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </select>
        </Field>

        <Field label="Bill to, name and address">
          <textarea
            value={address}
            onChange={(e) => setAddress(e.target.value)}
            className={inputCls}
            rows={3}
            placeholder={"The Chairman\nICAI Rajkot Branch\nRajkot"}
          />
        </Field>

        <div>
          <p className="text-xs font-medium text-secondary">Line items</p>
          <div className="mt-1.5 space-y-2">
            {items.map((it, i) => (
              <div key={i} className="rounded-xl border border-border p-2.5">
                <div className="flex gap-2">
                  <input
                    type="date"
                    value={it.date}
                    onChange={(e) => patch(i, { date: e.target.value })}
                    className={inputCls + " max-w-[45%]"}
                    aria-label="Line date"
                  />
                  <input
                    type="number"
                    inputMode="decimal"
                    value={it.amount}
                    onChange={(e) => patch(i, { amount: Number(e.target.value) })}
                    className={inputCls}
                    aria-label="Line amount"
                  />
                </div>
                <input
                  value={it.description}
                  onChange={(e) => patch(i, { description: e.target.value })}
                  className={inputCls + " mt-2"}
                  aria-label="Line description"
                />
                <button
                  type="button"
                  onClick={() => setItems(items.filter((_, j) => j !== i))}
                  className="mt-1 min-h-11 text-xs font-medium text-overdue"
                >
                  Remove line
                </button>
              </div>
            ))}
          </div>
          <button
            type="button"
            onClick={() =>
              setItems([...items, { date, description: "", amount: 0 }])
            }
            className="press mt-2 min-h-11 rounded-lg border border-border-strong px-3 text-xs font-medium"
          >
            + Line
          </button>
        </div>

        <div className="rounded-xl border border-border bg-surface-2 p-3">
          <div className="flex items-baseline justify-between">
            <span className="text-sm text-secondary">Total</span>
            <span className="text-lg font-semibold">{formatINR(total)}</span>
          </div>
          <p className="mt-1 text-xs text-secondary">{amountInWordsIndian(total)}</p>
        </div>

        {err && <p className="text-sm text-overdue">{err}</p>}

        <div className={drawerFooterCls}>
          <button
            onClick={submit}
            disabled={pending}
            className="press w-full rounded-lg bg-accent px-3 py-2 text-sm font-medium text-white disabled:opacity-50 dark:text-neutral-950"
          >
            {pending ? "Saving" : "Save draft"}
          </button>
        </div>
      </div>
    </Drawer>
  );
}
