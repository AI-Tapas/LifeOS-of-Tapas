"use client";

// Shared display bits for the Travel Desk: the purpose chip, the billed-to
// chip and the status trail. Kept in one file so the list, the detail screen
// and the month pack all speak the same visual language.

import { BILLS_TO_LABELS, type BillsTo } from "@/lib/trips/month";
import type { Database } from "@/lib/database.types";

export type TripPurpose = Database["public"]["Enums"]["trip_purpose"];
export type TripStatus = Database["public"]["Enums"]["trip_status"];

export const PURPOSES: TripPurpose[] = ["aica", "conference", "leisure", "other"];

export const PURPOSE_LABELS: Record<TripPurpose, string> = {
  aica: "AICA",
  conference: "Conference",
  leisure: "Leisure",
  other: "Other",
};

// The trail he actually works to. 'booked' and 'cancelled' are older values
// that stay valid; they show as a plain chip rather than a trail position.
export const STATUS_TRAIL: TripStatus[] = ["planned", "underway", "done", "billed"];

export const STATUS_LABELS: Record<TripStatus, string> = {
  planned: "Planned",
  booked: "Booked",
  underway: "Underway",
  done: "Done",
  billed: "Billed",
  cancelled: "Cancelled",
};

export function PurposeChip({ purpose }: { purpose: TripPurpose }) {
  const tone =
    purpose === "aica"
      ? "border-brand/40 bg-brand-soft text-brand-deep"
      : purpose === "conference"
        ? "border-waiting/30 bg-waiting-soft text-waiting"
        : purpose === "leisure"
          ? "border-ok/30 bg-ok-soft text-ok"
          : "border-border bg-surface-2 text-secondary";
  return (
    <span
      className={
        "shrink-0 rounded-full border px-2.5 py-0.5 text-[11px] font-semibold " + tone
      }
    >
      {PURPOSE_LABELS[purpose]}
    </span>
  );
}

// Read-only by default. Pass onPick to let a tap advance the trip, which is
// what the detail screen does.
export function StatusTrail({
  status,
  onPick,
  disabled = false,
}: {
  status: TripStatus;
  onPick?: (next: TripStatus) => void;
  disabled?: boolean;
}) {
  if (!STATUS_TRAIL.includes(status)) {
    return (
      <span className="rounded-full border border-border bg-surface-2 px-2.5 py-0.5 text-[11px] font-semibold text-secondary">
        {STATUS_LABELS[status]}
      </span>
    );
  }
  const at = STATUS_TRAIL.indexOf(status);
  return (
    <div className="flex flex-wrap items-center gap-1">
      {STATUS_TRAIL.map((s, i) => {
        const reached = i <= at;
        const here = i === at;
        const cls =
          "rounded-full px-2.5 py-0.5 text-[11px] font-semibold " +
          (here
            ? "bg-accent text-white dark:text-neutral-950"
            : reached
              ? "bg-accent-soft text-accent"
              : "text-muted");
        return (
          <span key={s} className="flex items-center gap-1">
            {onPick ? (
              <button
                type="button"
                disabled={disabled}
                onClick={() => onPick(s)}
                aria-pressed={here}
                className={"press min-h-11 " + cls}
              >
                {STATUS_LABELS[s]}
              </button>
            ) : (
              <span className={cls}>{STATUS_LABELS[s]}</span>
            )}
            {i < STATUS_TRAIL.length - 1 && (
              <span aria-hidden className="text-[10px] text-muted">
                &gt;
              </span>
            )}
          </span>
        );
      })}
    </div>
  );
}

// How the trip is billed. Only ever shown for the two cases that are NOT the
// monthly ICAI claim: an overseas chapter, which must be invoiced separately
// in AED, and a trip nobody reimburses. The default case needs no chip.
export function BillsToChip({ billsTo }: { billsTo: BillsTo }) {
  if (billsTo === "icai_monthly") return null;
  const tone =
    billsTo === "chapter_aed"
      ? "border-waiting/30 bg-waiting-soft text-waiting"
      : "border-border bg-surface-2 text-secondary";
  return (
    <span
      className={
        "inline-block rounded-full border px-2.5 py-0.5 text-[11px] font-semibold " +
        tone
      }
    >
      {BILLS_TO_LABELS[billsTo]}
    </span>
  );
}
