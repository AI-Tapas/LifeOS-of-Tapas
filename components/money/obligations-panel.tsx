"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Drawer, Field, inputCls } from "@/components/ui";
import { formatINR } from "@/lib/datetime";
import {
  createObligationAction,
  updateObligationAction,
  setObligationActiveAction,
  deleteObligationAction,
  type ObligationInput,
} from "@/app/(app)/money/actions";

type Category =
  | "gas"
  | "electricity"
  | "credit_card"
  | "insurance"
  | "broadband"
  | "rent"
  | "subscription"
  | "other";
type Frequency = "monthly" | "bi_monthly" | "quarterly" | "half_yearly" | "yearly";

export interface ObligationRow {
  id: string;
  name: string;
  category: Category;
  amount: number | null;
  variable_amount: boolean;
  frequency: Frequency;
  due_day: number | null;
  due_month: number | null;
  autopay: boolean;
  account_ref: string | null;
  active: boolean;
  notes: string | null;
  remind_offsets: number[];
}

const CATEGORIES: Category[] = [
  "gas",
  "electricity",
  "credit_card",
  "insurance",
  "broadband",
  "rent",
  "subscription",
  "other",
];
const FREQUENCIES: Frequency[] = [
  "monthly",
  "bi_monthly",
  "quarterly",
  "half_yearly",
  "yearly",
];
const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

function label(s: string): string {
  return s.replace(/_/g, " ");
}
function dueLabel(o: ObligationRow): string {
  if (!o.due_day) return "no due day";
  if (o.frequency === "yearly") {
    return `${o.due_day} ${o.due_month ? MONTHS[o.due_month - 1] : ""}`.trim();
  }
  return `day ${o.due_day}`;
}

export default function ObligationsPanel({
  obligations,
}: {
  obligations: ObligationRow[];
}) {
  const router = useRouter();
  const [editing, setEditing] = useState<ObligationRow | "new" | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function toggleActive(o: ObligationRow) {
    startTransition(async () => {
      const r = await setObligationActiveAction(o.id, !o.active);
      if (r.ok && r.reminderNote) setNotice(r.reminderNote);
      router.refresh();
    });
  }

  return (
    <div>
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-medium">Obligations</h2>
          <p className="text-sm text-neutral-500">
            Recurring bills and payments. Each active one sets a Google Calendar reminder.
          </p>
        </div>
        <button
          onClick={() => setEditing("new")}
          className="shrink-0 rounded-lg bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white"
        >
          + Add
        </button>
      </div>

      {notice && (
        <p className="mt-3 rounded-lg border border-amber-300 bg-amber-50 p-2 text-xs text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200">
          {notice}
        </p>
      )}

      <div className="mt-4 space-y-2">
        {obligations.length === 0 ? (
          <p className="text-sm text-neutral-400">No obligations yet.</p>
        ) : (
          obligations.map((o) => (
            <div
              key={o.id}
              className="rounded-lg border border-neutral-200 p-3 dark:border-neutral-800"
            >
              <div className="flex items-start justify-between gap-2">
                <button onClick={() => setEditing(o)} className="min-w-0 text-left">
                  <p className="font-medium">{o.name}</p>
                  <p className="text-xs capitalize text-neutral-500">
                    {label(o.category)} · {label(o.frequency)} · {dueLabel(o)}
                  </p>
                  <p className="mt-0.5 text-sm">
                    {o.variable_amount ? "Variable amount" : formatINR(o.amount)}
                    {o.autopay ? " · autopay" : ""}
                    {o.account_ref ? ` · ${o.account_ref}` : ""}
                  </p>
                </button>
                <label className="flex shrink-0 items-center gap-1 text-xs text-neutral-500">
                  <input
                    type="checkbox"
                    checked={o.active}
                    disabled={pending}
                    onChange={() => toggleActive(o)}
                  />
                  Active
                </label>
              </div>
            </div>
          ))
        )}
      </div>

      {editing && (
        <ObligationForm
          obligation={editing === "new" ? null : editing}
          onClose={() => setEditing(null)}
          onNotice={setNotice}
        />
      )}
    </div>
  );
}

interface Fields {
  name: string;
  category: Category;
  variable: boolean;
  amount: string;
  frequency: Frequency;
  dueDay: string;
  dueMonth: string;
  autopay: boolean;
  accountRef: string;
  active: boolean;
  notes: string;
  offsets: string;
}

function toFields(o: ObligationRow | null): Fields {
  return {
    name: o?.name ?? "",
    category: o?.category ?? "other",
    variable: o?.variable_amount ?? false,
    amount: o?.amount != null ? String(o.amount) : "",
    frequency: o?.frequency ?? "monthly",
    dueDay: o?.due_day != null ? String(o.due_day) : "",
    dueMonth: o?.due_month != null ? String(o.due_month) : "",
    autopay: o?.autopay ?? false,
    accountRef: o?.account_ref ?? "",
    active: o?.active ?? true,
    notes: o?.notes ?? "",
    offsets: (o?.remind_offsets ?? [7, 3, 1, 0]).join(", "),
  };
}

function ObligationForm({
  obligation,
  onClose,
  onNotice,
}: {
  obligation: ObligationRow | null;
  onClose: () => void;
  onNotice: (s: string | null) => void;
}) {
  const router = useRouter();
  const [f, setF] = useState<Fields>(() => toFields(obligation));
  const [pending, startTransition] = useTransition();
  const [err, setErr] = useState<string | null>(null);
  const isEdit = !!obligation;

  function buildInput(): ObligationInput {
    const offsets = f.offsets
      .split(/[,\s]+/)
      .map((x) => parseInt(x, 10))
      .filter((n) => Number.isInteger(n) && n >= 0 && n <= 28);
    return {
      name: f.name,
      category: f.category,
      variable_amount: f.variable,
      amount: f.variable ? null : f.amount ? Number(f.amount) : null,
      frequency: f.frequency,
      due_day: f.dueDay ? parseInt(f.dueDay, 10) : null,
      due_month: f.frequency === "yearly" && f.dueMonth ? parseInt(f.dueMonth, 10) : null,
      autopay: f.autopay,
      account_ref: f.accountRef || null,
      active: f.active,
      notes: f.notes || null,
      remind_offsets: offsets.length ? offsets : [7, 3, 1, 0],
    };
  }

  function submit() {
    setErr(null);
    const input = buildInput();
    if (!input.name.trim()) {
      setErr("A name is required.");
      return;
    }
    startTransition(async () => {
      const r = isEdit
        ? await updateObligationAction(obligation!.id, input)
        : await createObligationAction(input);
      if (r.ok) {
        if (r.reminderNote) onNotice(r.reminderNote);
        onClose();
        router.refresh();
      } else {
        setErr(r.message);
      }
    });
  }

  function remove() {
    if (!obligation) return;
    if (!confirm("Delete this obligation?")) return;
    startTransition(async () => {
      await deleteObligationAction(obligation.id);
      onClose();
      router.refresh();
    });
  }

  return (
    <Drawer title={isEdit ? "Edit obligation" : "New obligation"} onClose={onClose}>
      <div className="space-y-3">
        <Field label="Name">
          <input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} className={inputCls} />
        </Field>
        <div className="flex gap-2">
          <Field label="Category">
            <select
              value={f.category}
              onChange={(e) => setF({ ...f, category: e.target.value as Category })}
              className={inputCls}
            >
              {CATEGORIES.map((c) => (
                <option key={c} value={c} className="capitalize">
                  {label(c)}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Frequency">
            <select
              value={f.frequency}
              onChange={(e) => setF({ ...f, frequency: e.target.value as Frequency })}
              className={inputCls}
            >
              {FREQUENCIES.map((c) => (
                <option key={c} value={c}>
                  {label(c)}
                </option>
              ))}
            </select>
          </Field>
        </div>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={f.variable}
            onChange={(e) => setF({ ...f, variable: e.target.checked })}
          />
          Variable amount
        </label>
        {!f.variable && (
          <Field label="Amount (₹)">
            <input
              type="number"
              inputMode="decimal"
              value={f.amount}
              onChange={(e) => setF({ ...f, amount: e.target.value })}
              className={inputCls}
            />
          </Field>
        )}
        <div className="flex gap-2">
          <Field label="Due day (1-31)">
            <input
              type="number"
              min={1}
              max={31}
              value={f.dueDay}
              onChange={(e) => setF({ ...f, dueDay: e.target.value })}
              className={inputCls}
            />
          </Field>
          {f.frequency === "yearly" && (
            <Field label="Due month">
              <select
                value={f.dueMonth}
                onChange={(e) => setF({ ...f, dueMonth: e.target.value })}
                className={inputCls}
              >
                <option value="">Month</option>
                {MONTHS.map((m, i) => (
                  <option key={m} value={i + 1}>
                    {m}
                  </option>
                ))}
              </select>
            </Field>
          )}
        </div>
        <Field label="Account reference (free text)">
          <input
            value={f.accountRef}
            onChange={(e) => setF({ ...f, accountRef: e.target.value })}
            className={inputCls}
            placeholder="e.g. HDFC card ...1234"
          />
        </Field>
        <div className="flex gap-4">
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={f.autopay}
              onChange={(e) => setF({ ...f, autopay: e.target.checked })}
            />
            Autopay
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={f.active}
              onChange={(e) => setF({ ...f, active: e.target.checked })}
            />
            Active
          </label>
        </div>
        <Field label="Remind (days before, comma separated; max 5, max 28)">
          <input
            value={f.offsets}
            onChange={(e) => setF({ ...f, offsets: e.target.value })}
            className={inputCls}
          />
        </Field>
        <Field label="Notes">
          <textarea
            value={f.notes}
            onChange={(e) => setF({ ...f, notes: e.target.value })}
            className={inputCls}
            rows={2}
          />
        </Field>

        {err && <p className="text-sm text-red-600">{err}</p>}
        <div className="flex gap-2">
          <button
            onClick={submit}
            disabled={pending}
            className="flex-1 rounded-lg bg-indigo-600 px-3 py-2 text-sm font-medium text-white disabled:opacity-50"
          >
            {pending ? "Saving" : isEdit ? "Save" : "Create"}
          </button>
          {isEdit && (
            <button
              onClick={remove}
              disabled={pending}
              className="rounded-lg border border-neutral-300 px-3 py-2 text-sm text-red-600 disabled:opacity-50 dark:border-neutral-700"
            >
              Delete
            </button>
          )}
        </div>
      </div>
    </Drawer>
  );
}
