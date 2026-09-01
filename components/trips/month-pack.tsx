"use client";

// The month pack: everything his invoice run needs from Life OS for one
// month, and deliberately nothing more.
//
// It shows no total, no invoice number and offers no PDF. That is not an
// omission: he invoices monthly from a formula-driven workbook on his own
// machine, from one continuous number series across all his clients, and a
// number on this screen would only compete with the real one. The single
// integration is the copy button.

import { useMemo, useState } from "react";
import Link from "next/link";
import { BandHead, Card, Empty, PageHeader, SectionLabel, btnSmall } from "@/components/ui";
import { formatINR } from "@/lib/datetime";
import { MODE_LABELS, dayLabel, type TransportMode } from "@/lib/trips/core";
import {
  buildMonthPack,
  categoryLabel,
  monthLabel,
  monthPackText,
  shiftMonth,
  type MonthExpense,
  type MonthTrip,
} from "@/lib/trips/month";

export default function MonthPack({
  trips,
  expenses,
  defaultMonth,
  maxMonth,
}: {
  trips: MonthTrip[];
  expenses: MonthExpense[];
  // The month just gone: the one he invoices.
  defaultMonth: string;
  // No stepping into the future; there is nothing to invoice there.
  maxMonth: string;
}) {
  const [month, setMonth] = useState(defaultMonth);
  const [copied, setCopied] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);

  const pack = useMemo(
    () => buildMonthPack(trips, expenses, month),
    [trips, expenses, month]
  );
  const text = useMemo(() => monthPackText(pack), [pack]);

  const tripTitle = (id: string) =>
    trips.find((t) => t.id === id)?.title ?? "Trip";

  // The clipboard is refused outright on an insecure origin and can be denied
  // by the browser, and this button is the app's ONLY handover to his invoice
  // run. A silent failure here looks exactly like a successful copy, so he
  // would paste last month's clipboard into the workbook. Say so instead, and
  // put the text on screen to select by hand.
  async function copy() {
    setCopyFailed(false);
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2500);
    } catch {
      setCopied(false);
      setCopyFailed(true);
    }
  }

  return (
    <div>
      <Link href="/trips" className="text-xs font-semibold text-secondary">
        Back to trips
      </Link>

      <div className="mt-2">
        <PageHeader
          title={monthLabel(pack.month_key)}
          subtitle="What your invoice run needs. Records only, not a claim."
        />
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button
          onClick={() => setMonth(shiftMonth(month, -1))}
          className={btnSmall}
        >
          Earlier month
        </button>
        <button
          onClick={() => setMonth(shiftMonth(month, 1))}
          disabled={month >= maxMonth}
          className={btnSmall + " disabled:opacity-40"}
        >
          Later month
        </button>
        <button onClick={copy} className={btnSmall}>
          {copied ? "Copied" : "Copy for the invoice run"}
        </button>
      </div>

      {copyFailed && (
        <div className="mt-3 rounded-xl border border-overdue/30 bg-overdue-soft p-3">
          <p className="text-sm text-overdue">
            This browser would not let the app write to the clipboard. Nothing
            was copied. Select the text below and copy it by hand.
          </p>
          <textarea
            readOnly
            value={text}
            className="mt-2 h-64 w-full rounded-lg border border-border bg-surface p-2 font-mono text-xs"
          />
        </div>
      )}

      <p className="mt-3 rounded-xl border border-border bg-surface-2 p-3 text-xs text-secondary">
        Life OS does not raise the invoice. It holds the month accurately and
        hands it over: paste this into the session that fills the workbook. No
        totals, no invoice number, no fee are computed here on purpose.
      </p>

      {/* --- sessions --------------------------------------------------- */}
      <section className="mt-6">
        <div className="mb-2">
          <BandHead title="Sessions" count={pack.sessions.length} />
        </div>
        {pack.sessions.length === 0 ? (
          <Empty title="No sessions in this month.">
            Nothing here goes on the monthly ICAI claim.
          </Empty>
        ) : (
          <div className="space-y-2">
            {pack.sessions.map((s) => (
              <Link
                key={s.trip_id}
                href={`/trips/${s.trip_id}`}
                className="press block rounded-xl border border-border bg-surface p-3 shadow-[var(--shadow-card)]"
              >
                <p className="truncate text-sm font-semibold text-brand-deep">
                  {s.cities.join(", ") || "No city recorded"}
                </p>
                <p className="mt-0.5 text-xs text-secondary">{s.dates}</p>
                <p className="mt-0.5 truncate text-xs text-muted">{s.title}</p>
              </Link>
            ))}
          </div>
        )}
      </section>

      {/* --- legs ------------------------------------------------------- */}
      <section className="mt-6">
        <div className="mb-2">
          <BandHead title="Travel legs" count={pack.legs.length} />
        </div>
        {pack.legs.length === 0 ? (
          <Empty title="No legs logged for this month.">
            Add them on the trip and they appear here.
          </Empty>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[26rem] text-left text-xs">
              <thead className="text-muted">
                <tr>
                  <th className="py-1.5 pr-3 font-semibold">Date</th>
                  <th className="py-1.5 pr-3 font-semibold">From</th>
                  <th className="py-1.5 pr-3 font-semibold">To</th>
                  <th className="py-1.5 pr-3 font-semibold">Mode</th>
                  <th className="py-1.5 text-right font-semibold">Cost</th>
                </tr>
              </thead>
              <tbody>
                {pack.legs.map((l, i) => (
                  <tr key={`${l.trip_id}-${l.date}-${i}`} className="border-t border-border">
                    <td className="py-1.5 pr-3 whitespace-nowrap">
                      {dayLabel(l.date, true) || "no date"}
                    </td>
                    <td className="py-1.5 pr-3">{l.from || "?"}</td>
                    <td className="py-1.5 pr-3">{l.to || "?"}</td>
                    <td className="py-1.5 pr-3">
                      {MODE_LABELS[l.mode as TransportMode]}
                    </td>
                    <td className="py-1.5 text-right whitespace-nowrap">
                      {l.cost != null ? formatINR(l.cost) : "not recorded"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* --- expenses --------------------------------------------------- */}
      <section className="mt-6">
        <div className="mb-2">
          <BandHead title="Expenses" count={pack.expense_groups.length} />
        </div>
        {pack.expense_groups.length === 0 ? (
          <Empty title="No expenses recorded for this month.">
            Log them on the trip and they appear here.
          </Empty>
        ) : (
          <div className="space-y-4">
            {pack.expense_groups.map((g) => (
              <div key={g.trip_id}>
                <SectionLabel className="mb-1.5">
                  {g.cities.join(", ") || g.title}
                </SectionLabel>
                <div className="space-y-1.5">
                  {g.expenses.map((e) => (
                    <div
                      key={e.id}
                      className="flex items-start justify-between gap-2 rounded-xl border border-border bg-surface p-3 text-xs shadow-[var(--shadow-card)]"
                    >
                      <div className="min-w-0">
                        <p>
                          {dayLabel(e.date, true)} · {categoryLabel(e.category)}
                          {e.billable ? "" : " · own cost"}
                        </p>
                        <p
                          className={
                            "mt-0.5 truncate " +
                            ((e.receipt_ref ?? "").trim()
                              ? "text-muted"
                              : "font-semibold text-waiting")
                          }
                        >
                          {(e.receipt_ref ?? "").trim() || "no receipt on file"}
                        </p>
                      </div>
                      <span className="shrink-0 font-medium">
                        {formatINR(e.amount)}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* --- excluded --------------------------------------------------- */}
      <section className="mt-6">
        <div className="mb-2">
          <BandHead title="Excluded from this claim" count={pack.excluded.length} />
        </div>
        {pack.excluded.length === 0 ? (
          <Empty title="Nothing excluded this month.">
            Every trip in this month goes on the ICAI claim.
          </Empty>
        ) : (
          <div className="space-y-2">
            {pack.excluded.map((x) => (
              <Card key={x.trip_id}>
                <p className="truncate text-sm font-semibold text-brand-deep">
                  {x.cities.join(", ") || "No city recorded"}
                </p>
                <p className="mt-0.5 text-xs text-secondary">{x.dates}</p>
                <p className="mt-0.5 truncate text-xs text-muted">{x.title}</p>
                <p className="mt-1.5 text-xs text-waiting">{x.reason}</p>
              </Card>
            ))}
          </div>
        )}
      </section>

      {/* --- gaps ------------------------------------------------------- */}
      <section className="mt-6 mb-4">
        <div className="mb-2">
          <BandHead title="Gaps" count={pack.gaps.length} />
        </div>
        {pack.gaps.length === 0 ? (
          <Empty title="No gaps.">
            Every billable expense in this month has a receipt reference.
          </Empty>
        ) : (
          <ol className="list-decimal space-y-1.5 rounded-xl border border-waiting/30 bg-waiting-soft p-3 pl-7 text-xs text-waiting">
            {pack.gaps.map((e) => (
              <li key={e.id}>
                {dayLabel(e.date, true)}, {categoryLabel(e.category)},{" "}
                {formatINR(e.amount)},{" "}
                {tripTitle(e.trip_id)}
              </li>
            ))}
          </ol>
        )}
      </section>
    </div>
  );
}
