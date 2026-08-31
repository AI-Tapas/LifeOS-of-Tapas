"use client";

// Trips overview. It leads with the month ahead, grouped, because the first
// job on this screen is triaging the whole month, not reading a flat table.
// Past trips sit below, newest first, for the billing tail.

import { useMemo, useState } from "react";
import Link from "next/link";
import { BandHead, Empty, PageHeader, SectionLabel, btnPrimary } from "@/components/ui";
import { formatINR, formatMonthYear } from "@/lib/datetime";
import { tripDatesLabel } from "@/lib/trips/bill";
import {
  PurposeChip,
  StatusTrail,
  type TripPurpose,
  type TripStatus,
} from "@/components/trips/bits";
import TripForm, { type WorkStreamRow } from "@/components/trips/trip-form";

export type { WorkStreamRow };

export interface TripRow {
  id: string;
  purpose: TripPurpose;
  title: string;
  work_stream_id: string;
  start_date: string | null;
  end_date: string | null;
  cities: string[];
  status: TripStatus;
  billable_to: string | null;
  notes: string | null;
  stream_name: string;
  billable_total: number;
  expense_count: number;
  // Checklist progress: steps done and steps still owed, dropped ones aside.
  checklist_done: number;
  checklist_total: number;
  bill_count: number;
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

function monthLabel(key: string): string {
  if (!key) return "No dates yet";
  return formatMonthYear({ y: Number(key.slice(0, 4)), m: Number(key.slice(5, 7)), d: 1 });
}

function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(b) - Date.parse(a)) / 86400000);
}

export default function TripsView({
  trips,
  workStreams,
  todayKey,
}: {
  trips: TripRow[];
  workStreams: WorkStreamRow[];
  todayKey: string;
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
    .filter((t) => t.status !== "billed" && t.billable_total > 0)
    .reduce((sum, t) => sum + t.billable_total, 0);

  return (
    <div>
      <PageHeader
        title="Trips"
        subtitle="The month ahead, then what is left to bill"
        action={
          <button onClick={() => setAdding(true)} className={btnPrimary}>
            + Trip
          </button>
        }
      />

      {claimable > 0 && (
        <p className="mt-3 rounded-xl border border-waiting/30 bg-waiting-soft p-3 text-xs text-waiting">
          {formatINR(claimable)} of billable expense is not on a bill yet. Open
          the trip and build the bill.
        </p>
      )}

      {months.length === 0 ? (
        <div className="mt-5">
          <Empty title="No trips ahead.">
            Use + Trip to plan one. An AICA trip collects its expenses here and
            turns them into the institute reimbursement bill.
          </Empty>
        </div>
      ) : (
        months.map(([key, items]) => (
          <section key={key || "undated"} className="mt-5">
            <div className="mb-2">
              <BandHead title={monthLabel(key)} count={items.length} />
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
  return (
    <Link
      href={`/trips/${trip.id}`}
      className="press block rounded-2xl border border-border bg-surface p-3.5 shadow-[var(--shadow-card)]"
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate font-medium">{trip.title}</p>
          <p className="mt-0.5 text-xs text-secondary">
            {tripDatesLabel(trip.start_date, trip.end_date)}
            {trip.stream_name ? ` · ${trip.stream_name}` : ""}
            {trip.cities.length ? ` · ${trip.cities.join(", ")}` : ""}
          </p>
        </div>
        <PurposeChip purpose={trip.purpose} />
      </div>
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
  return (
    <p className="mt-1.5 rounded-lg border border-dashed border-border-strong px-3 py-2 text-[11px] text-secondary">
      {gap} days between this and the next trip. Chaining them into one trip is
      a question worth asking, not a default: staying on costs hotel nights,
      going home costs a return leg.
    </p>
  );
}
