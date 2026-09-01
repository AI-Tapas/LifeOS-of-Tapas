"use client";

// Trips overview. It leads with the month ahead, grouped, because the first
// job on this screen is triaging the whole month, not reading a flat table.
// Past trips sit below, newest first, for the invoicing tail.
//
// The city is the strongest thing on a trip line after its own name. With the
// branch name gone (M6d), the city is what he actually reads to know which
// session a row is.

import { useMemo, useState } from "react";
import Link from "next/link";
import {
  BandHead,
  Empty,
  PageHeader,
  SectionLabel,
  btnPrimary,
  btnSmall,
} from "@/components/ui";
import { formatINR } from "@/lib/datetime";
import { sessionLine, tripDatesLabel, travelDiffersFromSession } from "@/lib/trips/bill";
import {
  BillsToChip,
  PurposeChip,
  StatusTrail,
  type TripPurpose,
  type TripStatus,
} from "@/components/trips/bits";
import { monthLabel, type BillsTo } from "@/lib/trips/month";
import TripForm, { type WorkStreamRow } from "@/components/trips/trip-form";

export type { WorkStreamRow };

export interface TripRow {
  id: string;
  purpose: TripPurpose;
  title: string;
  session_label: string | null;
  session_date: string | null;
  work_stream_id: string;
  start_date: string | null;
  end_date: string | null;
  cities: string[];
  status: TripStatus;
  bills_to: BillsTo;
  notes: string | null;
  stream_name: string;
  billable_total: number;
  expense_count: number;
  // Checklist progress: steps done and steps still owed, dropped ones aside.
  checklist_done: number;
  checklist_total: number;
  // Billable expenses on this trip with no receipt reference.
  receipts_missing: number;
}

// A trip is still ahead until the day after it ends.
function isUpcoming(t: TripRow, todayKey: string): boolean {
  const last = t.end_date ?? t.start_date;
  if (!last) return true; // undated plans are ahead of him, not behind
  return last >= todayKey;
}

function monthKey(t: TripRow): string {
  return t.start_date ? t.start_date.slice(0, 7) : "";
}

function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(b) - Date.parse(a)) / 86400000);
}

export default function TripsView({
  trips,
  workStreams,
  todayKey,
  receiptGapCount,
  receiptGapMonths,
}: {
  trips: TripRow[];
  workStreams: WorkStreamRow[];
  todayKey: string;
  // Billable expenses with no receipt reference, in the month running and the
  // one just gone. Chasing them now is far cheaper than chasing them at
  // invoice time.
  receiptGapCount: number;
  receiptGapMonths: string[];
}) {
  const [adding, setAdding] = useState(false);

  const { months, past } = useMemo(() => {
    const upcoming = trips
      .filter((t) => isUpcoming(t, todayKey))
      .sort((a, b) => (a.start_date ?? "9999").localeCompare(b.start_date ?? "9999"));
    const groups = new Map<string, TripRow[]>();
    for (const t of upcoming) {
      const k = monthKey(t);
      groups.set(k, [...(groups.get(k) ?? []), t]);
    }
    return {
      months: [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0])),
      past: trips
        .filter((t) => !isUpcoming(t, todayKey))
        .sort((a, b) => (b.start_date ?? "").localeCompare(a.start_date ?? "")),
    };
  }, [trips, todayKey]);

  const claimable = trips
    .filter((t) => t.bills_to === "icai_monthly" && t.billable_total > 0)
    .reduce((sum, t) => sum + t.billable_total, 0);

  return (
    <div>
      <PageHeader
        title="Trips"
        subtitle="The month ahead, then the month you invoice"
        action={
          <button onClick={() => setAdding(true)} className={btnPrimary}>
            + Trip
          </button>
        }
      />

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Link href="/trips/month" className={btnSmall + " py-2"}>
          Month pack
        </Link>
        {claimable > 0 && (
          <span className="text-xs text-secondary">
            {formatINR(claimable)} of billable expense recorded for the monthly
            claim.
          </span>
        )}
      </div>

      {receiptGapCount > 0 && (
        <p className="mt-3 rounded-xl border border-waiting/30 bg-waiting-soft p-3 text-xs text-waiting">
          {receiptGapCount} billable{" "}
          {receiptGapCount === 1 ? "expense has" : "expenses have"} no receipt
          reference in {receiptGapMonths.map(monthLabel).join(" or ")}. Chase
          them now, not at invoice time.
        </p>
      )}

      {months.length === 0 ? (
        <div className="mt-5">
          <Empty title="No trips ahead.">
            Use + Trip to plan one. An AICA trip collects its legs and expenses
            here, and the month pack hands them to your invoice run.
          </Empty>
        </div>
      ) : (
        months.map(([key, items]) => (
          <section key={key || "undated"} className="mt-5">
            <div className="mb-2">
              <BandHead
                title={key ? monthLabel(key) : "No dates yet"}
                count={items.length}
              />
            </div>
            <div className="space-y-2">
              {items.map((t, i) => (
                <div key={t.id}>
                  <TripCard trip={t} />
                  <ChainHint previous={items[i]} next={items[i + 1]} />
                </div>
              ))}
            </div>
          </section>
        ))
      )}

      {past.length > 0 && (
        <section className="mt-7">
          <SectionLabel className="mb-2">Past trips</SectionLabel>
          <div className="space-y-2">
            {past.map((t) => (
              <TripCard key={t.id} trip={t} />
            ))}
          </div>
        </section>
      )}

      {adding && (
        <TripForm
          trip={null}
          workStreams={workStreams}
          onClose={() => setAdding(false)}
        />
      )}
    </div>
  );
}

function TripCard({ trip }: { trip: TripRow }) {
  const session = sessionLine(trip.session_label, trip.session_date);
  // Only worth a line when it says something the session date does not: a
  // day return would just repeat itself.
  const showTravel = travelDiffersFromSession(
    trip.start_date,
    trip.end_date,
    trip.session_date
  );
  return (
    <Link
      href={`/trips/${trip.id}`}
      className="press block rounded-2xl border border-border bg-surface p-3.5 shadow-[var(--shadow-card)]"
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          {/* The session first: which level, which day of the course, and
              the day he actually teaches. The travel span below is arrival
              and return, which is what he was having to decode. */}
          {session ? (
            <p className="truncate text-base font-semibold">
              {session}
              <span className="font-medium text-brand-deep">
                {trip.cities.length ? ` · ${trip.cities.join(", ")}` : ""}
              </span>
            </p>
          ) : (
            <p className="mt-0.5 truncate text-sm font-semibold text-brand-deep">
              {trip.cities.length ? trip.cities.join(", ") : "No city recorded"}
            </p>
          )}
          <p className="mt-0.5 truncate text-sm text-secondary">{trip.title}</p>
          {showTravel && (
            <p className="mt-0.5 text-xs text-secondary">
              Travel {tripDatesLabel(trip.start_date, trip.end_date)}
              {trip.stream_name ? ` · ${trip.stream_name}` : ""}
            </p>
          )}
        </div>
        <PurposeChip purpose={trip.purpose} />
      </div>
      {trip.bills_to !== "icai_monthly" && (
        <div className="mt-1.5">
          <BillsToChip billsTo={trip.bills_to} />
        </div>
      )}
      {trip.receipts_missing > 0 && (
        <p className="mt-1.5 text-xs text-waiting">
          {trip.receipts_missing} billable{" "}
          {trip.receipts_missing === 1 ? "expense has" : "expenses have"} no
          receipt reference
        </p>
      )}
      {trip.checklist_total > 0 && (
        <p className="mt-1.5 text-xs text-secondary">
          Checklist: {trip.checklist_done} of {trip.checklist_total} done
        </p>
      )}
      <div className="mt-2.5 flex flex-wrap items-center justify-between gap-2">
        <StatusTrail status={trip.status} />
        <span className="text-sm font-semibold">
          {trip.billable_total > 0 ? formatINR(trip.billable_total) : ""}
          {trip.expense_count === 0 && (
            <span className="text-xs font-normal text-muted">no expenses yet</span>
          )}
        </span>
      </div>
    </Link>
  );
}

// Rule from his own practice: when two sessions sit more than a day apart,
// running them as one trip is a QUESTION, never an automatic merge. So this
// only observes the gap. There is no chain button, and nothing merges by
// itself.
function ChainHint({ previous, next }: { previous?: TripRow; next?: TripRow }) {
  if (!previous || !next) return null;
  const a = previous.end_date ?? previous.start_date;
  const b = next.start_date;
  if (!a || !b) return null;
  const gap = daysBetween(a, b);
  if (gap <= 1 || gap > 6) return null;
  // Just the gap. Whether to chain two close trips into one is his call and he
  // does not need it explained every time; the number is the whole point.
  return (
    <p className="mt-1.5 px-3 py-1 text-[11px] text-muted">
      {gap} {gap === 1 ? "day" : "days"} before the next trip.
    </p>
  );
}
