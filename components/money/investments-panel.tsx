"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  Drawer,
  Empty,
  Field,
  btnGhost,
  btnPrimary,
  drawerFooterCls,
  inputCls,
} from "@/components/ui";
import { formatDateIST, formatINR } from "@/lib/datetime";
import {
  FINANCE_KINDS,
  KIND_LABELS,
  defaultKeyDateType,
  nextMaturity,
  nextReview,
  remindsOnCalendar,
  totalValue,
  totalsByKind,
  type FinanceKind,
  type Holding,
} from "@/lib/money/investments";
import {
  createHoldingAction,
  updateHoldingAction,
  deleteHoldingAction,
  type HoldingInput,
} from "@/app/(app)/money/actions";

type KeyDateType = "maturity" | "review";

export type HoldingRow = Holding;

// A plain date reads better here than a timestamp: key_date is a calendar
// date, so it is pinned to IST noon before formatting rather than being left
// to drift a day either side of midnight.
function dateLabel(key: string): string {
  return formatDateIST(`${key}T12:00:00+05:30`);
}

export default function InvestmentsPanel({
  holdings,
  todayKey,
}: {
  holdings: HoldingRow[];
  todayKey: string;
}) {
  const [editing, setEditing] = useState<HoldingRow | "new" | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const maturing = nextMaturity(holdings, todayKey);
  const review = nextReview(holdings, todayKey);
  const totals = totalsByKind(holdings);

  return (
    <div>
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-medium">Investments</h2>
          <p className="text-sm text-secondary">
            A maturity date interrupts you on the calendar. A review date stays
            here and on your morning brief.
          </p>
        </div>
        <button
          onClick={() => setEditing("new")}
          className="shrink-0 rounded-lg bg-accent px-3 py-1.5 text-sm font-medium text-white dark:text-neutral-950"
        >
          + Add
        </button>
      </div>

      {notice && (
        <p className="mt-3 rounded-lg border border-today/30 bg-today-soft p-2 text-xs text-today">
          {notice}
        </p>
      )}

      {holdings.length > 0 && (
        <div className="mt-4 grid grid-cols-1 gap-2 sm:grid-cols-2">
          <div className="rounded-lg border border-border bg-surface p-3 shadow-[var(--shadow-card)]">
            <p className="text-xs font-medium text-secondary">Maturing next</p>
            {maturing ? (
              <>
                <p className="mt-0.5 font-medium">{maturing.name}</p>
                <p className="text-sm text-secondary">
                  {dateLabel(maturing.key_date!)}
                  {maturing.value != null ? ` · ${formatINR(maturing.value)}` : ""}
                </p>
              </>
            ) : (
              <p className="mt-0.5 text-sm text-secondary">Nothing maturing.</p>
            )}
          </div>
          <div className="rounded-lg border border-border bg-surface p-3 shadow-[var(--shadow-card)]">
            <p className="text-xs font-medium text-secondary">Due for review</p>
            {review ? (
              <>
                <p className="mt-0.5 font-medium">{review.name}</p>
                <p className="text-sm text-secondary">{dateLabel(review.key_date!)}</p>
              </>
            ) : (
              <p className="mt-0.5 text-sm text-secondary">Nothing to review.</p>
            )}
          </div>
        </div>
      )}

      {totals.length > 0 && (
        <div className="mt-2 rounded-lg border border-border bg-surface p-3 shadow-[var(--shadow-card)]">
          <p className="text-xs font-medium text-secondary">By kind</p>
          <ul className="mt-1 divide-y divide-border">
            {totals.map((t) => (
              <li key={t.kind} className="flex items-baseline justify-between py-1.5">
                <span className="text-sm">
                  {t.label}
                  <span className="text-secondary"> · {t.count}</span>
                </span>
                <span className="text-sm font-medium tabular-nums">{t.total_label}</span>
              </li>
            ))}
            <li className="flex items-baseline justify-between py-1.5">
              <span className="text-sm font-medium">Recorded in total</span>
              <span className="text-sm font-semibold tabular-nums">
                {formatINR(totalValue(holdings))}
              </span>
            </li>
          </ul>
        </div>
      )}

      <div className="mt-4 space-y-2">
        {holdings.length === 0 ? (
          <Empty title="Nothing recorded yet">
            Add an FD, a fund, a stock or an NCD. A maturity date is chased on
            your calendar; a review date keeps an open holding from drifting
            for years.
          </Empty>
        ) : (
          holdings.map((h) => (
            <button
              key={h.id}
              onClick={() => setEditing(h)}
              className="block w-full rounded-lg border border-border bg-surface p-3 text-left shadow-[var(--shadow-card)]"
            >
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="font-medium">{h.name}</p>
                  <p className="text-xs text-secondary">
                    {KIND_LABELS[h.kind]}
                    {h.institution ? ` · ${h.institution}` : ""}
                  </p>
                  {h.key_date && (
                    <p className="mt-0.5 text-sm">
                      {h.key_date_type === "maturity" ? "Matures" : "Review"}{" "}
                      {dateLabel(h.key_date)}
                      {remindsOnCalendar(h) ? " · on the calendar" : ""}
                    </p>
                  )}
                </div>
                {h.value != null && (
                  <span className="shrink-0 text-sm font-medium tabular-nums">
                    {formatINR(h.value)}
                  </span>
                )}
              </div>
            </button>
          ))
        )}
      </div>

      {editing && (
        <HoldingForm
          holding={editing === "new" ? null : editing}
          onClose={() => setEditing(null)}
          onNotice={setNotice}
        />
      )}
    </div>
  );
}

interface Fields {
  kind: FinanceKind;
  name: string;
  institution: string;
  value: string;
  keyDate: string;
  keyDateType: KeyDateType;
  remind: boolean;
  notes: string;
}

function toFields(h: HoldingRow | null): Fields {
  const kind = h?.kind ?? "fd";
  return {
    kind,
    name: h?.name ?? "",
    institution: h?.institution ?? "",
    value: h?.value != null ? String(h.value) : "",
    keyDate: h?.key_date ?? "",
    keyDateType: h?.key_date_type ?? defaultKeyDateType(kind),
    remind: h?.remind ?? true,
    notes: h?.notes ?? "",
  };
}

function HoldingForm({
  holding,
  onClose,
  onNotice,
}: {
  holding: HoldingRow | null;
  onClose: () => void;
  onNotice: (s: string | null) => void;
}) {
  const router = useRouter();
  const [f, setF] = useState<Fields>(() => toFields(holding));
  // Whether he has chosen the date type himself. Until he does, changing the
  // kind moves it: an FD matures, a stock is reviewed. After he has, his
  // choice stands, the same rule the trip drawer uses for the hotel.
  const [typeTouched, setTypeTouched] = useState(!!holding?.key_date_type);
  const [pending, startTransition] = useTransition();
  const [err, setErr] = useState<string | null>(null);
  const [armed, setArmed] = useState(false);
  const isEdit = !!holding;

  function setKind(kind: FinanceKind) {
    setF({
      ...f,
      kind,
      keyDateType: typeTouched ? f.keyDateType : defaultKeyDateType(kind),
    });
  }

  function submit() {
    setErr(null);
    setArmed(false);
    const input: HoldingInput = {
      kind: f.kind,
      name: f.name,
      institution: f.institution || null,
      value: f.value ? Number(f.value) : null,
      key_date: f.keyDate || null,
      key_date_type: f.keyDate ? f.keyDateType : null,
      remind: f.remind,
      notes: f.notes || null,
    };
    startTransition(async () => {
      const r = isEdit
        ? await updateHoldingAction(holding!.id, input)
        : await createHoldingAction(input);
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
    if (!holding) return;
    if (!armed) {
      setArmed(true);
      return;
    }
    startTransition(async () => {
      await deleteHoldingAction(holding.id);
      onClose();
      router.refresh();
    });
  }

  return (
    <Drawer title={isEdit ? "Edit holding" : "New holding"} onClose={onClose}>
      <div className="space-y-3">
        <Field label="Name">
          <input
            value={f.name}
            onChange={(e) => setF({ ...f, name: e.target.value })}
            className={inputCls}
            placeholder="e.g. HDFC FD, 3 years"
          />
        </Field>
        <div className="flex gap-2">
          <Field label="Kind">
            <select
              value={f.kind}
              onChange={(e) => setKind(e.target.value as FinanceKind)}
              className={inputCls}
            >
              {FINANCE_KINDS.map((k) => (
                <option key={k} value={k}>
                  {KIND_LABELS[k]}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Value (₹)">
            <input
              type="number"
              inputMode="decimal"
              value={f.value}
              onChange={(e) => setF({ ...f, value: e.target.value })}
              className={inputCls}
            />
          </Field>
        </div>
        <Field label="Where it is held">
          <input
            value={f.institution}
            onChange={(e) => setF({ ...f, institution: e.target.value })}
            className={inputCls}
            placeholder="e.g. HDFC, Navrangpura"
          />
        </Field>
        <p className="text-xs text-secondary">
          A short label only. Never an account number, a folio number or a
          login: this app holds none of those, by design.
        </p>
        <div className="flex gap-2">
          <Field label="That date is a">
            <select
              value={f.keyDateType}
              onChange={(e) => {
                setTypeTouched(true);
                setF({ ...f, keyDateType: e.target.value as KeyDateType });
              }}
              className={inputCls}
            >
              <option value="maturity">Maturity</option>
              <option value="review">Review</option>
            </select>
          </Field>
          <Field label="Date">
            <input
              type="date"
              value={f.keyDate}
              onChange={(e) => setF({ ...f, keyDate: e.target.value })}
              className={inputCls}
            />
          </Field>
        </div>
        <p className="text-xs text-secondary">
          {f.keyDateType === "maturity"
            ? "A maturity writes one calendar reminder, 7, 3 and 1 days before and on the day."
            : "A review date writes no calendar entry. It shows on Home and in your 7 am brief."}
        </p>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={f.remind}
            onChange={(e) => setF({ ...f, remind: e.target.checked })}
          />
          Remind me about this one
        </label>
        <Field label="Notes">
          <textarea
            value={f.notes}
            onChange={(e) => setF({ ...f, notes: e.target.value })}
            className={inputCls}
            rows={2}
          />
        </Field>

        {err && <p className="text-sm text-overdue">{err}</p>}
        <div className={drawerFooterCls + " flex gap-2"}>
          <button onClick={submit} disabled={pending} className={btnPrimary + " flex-1"}>
            {pending ? "Saving" : isEdit ? "Save" : "Create"}
          </button>
          {isEdit && (
            <button
              onClick={remove}
              disabled={pending}
              className={
                armed
                  ? "press min-h-11 rounded-xl bg-red-600 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
                  : btnGhost + " text-overdue"
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
