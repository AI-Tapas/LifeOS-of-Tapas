"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Drawer, Field, drawerFooterCls, inputCls } from "@/components/ui";
import {
  PURPOSES,
  PURPOSE_LABELS,
  STATUS_LABELS,
  type TripPurpose,
  type TripStatus,
} from "@/components/trips/bits";
import {
  HOTEL_ARRANGEMENTS,
  HOTEL_HINTS,
  HOTEL_LABELS,
  HOTEL_SENTENCES,
  defaultHotelArrangement,
  type HotelArrangement,
} from "@/lib/trips/checklist";
import {
  createTripAction,
  deleteTripAction,
  updateTripAction,
} from "@/app/(app)/trips/actions";

export interface WorkStreamRow {
  id: string;
  name: string;
}

export interface TripFormValues {
  id?: string;
  purpose: TripPurpose;
  title: string;
  work_stream_id: string;
  start_date: string | null;
  end_date: string | null;
  cities: string[];
  status: TripStatus;
  billable_to: string | null;
  notes: string | null;
  hotel_arrangement: HotelArrangement | null;
}

const STATUS_CHOICES: TripStatus[] = [
  "planned",
  "underway",
  "done",
  "billed",
  "cancelled",
];

export default function TripForm({
  trip,
  workStreams,
  onClose,
  onDeleted,
}: {
  trip: TripFormValues | null;
  workStreams: WorkStreamRow[];
  onClose: () => void;
  onDeleted?: () => void;
}) {
  const router = useRouter();
  const isEdit = !!trip?.id;
  const [purpose, setPurpose] = useState<TripPurpose>(trip?.purpose ?? "aica");
  const [title, setTitle] = useState(trip?.title ?? "");
  const [streamId, setStreamId] = useState(
    trip?.work_stream_id ?? workStreams[0]?.id ?? ""
  );
  const [start, setStart] = useState(trip?.start_date ?? "");
  const [end, setEnd] = useState(trip?.end_date ?? "");
  const [cities, setCities] = useState((trip?.cities ?? []).join(", "));
  const [status, setStatus] = useState<TripStatus>(trip?.status ?? "planned");
  const [billableTo, setBillableTo] = useState(trip?.billable_to ?? "");
  const [notes, setNotes] = useState(trip?.notes ?? "");
  // Null means "still following the dates". On a new trip that is the
  // starting state, so entering one date in both fields flips the choice to
  // Same day before he saves. The moment he picks a value himself, or opens
  // an existing trip, it stops moving under him: a deliberate choice is never
  // overwritten by a later date edit.
  const [hotelPick, setHotelPick] = useState<HotelArrangement | null>(
    trip?.hotel_arrangement ??
      (isEdit
        ? defaultHotelArrangement(trip!.start_date, trip!.end_date)
        : null)
  );
  const hotel = hotelPick ?? defaultHotelArrangement(start || null, end || null);
  // Checked by default on a new trip: the five steps are what he runs every
  // time, and each one carries its own reminder. Never offered on an edit,
  // where the trip screen's Checklist section adds them instead.
  const [withChecklist, setWithChecklist] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [armed, setArmed] = useState(false);
  const [pending, startTransition] = useTransition();

  function submit() {
    setErr(null);
    setArmed(false);
    const input = {
      purpose,
      title,
      work_stream_id: streamId,
      start_date: start || null,
      end_date: end || null,
      cities: cities
        .split(",")
        .map((c) => c.trim())
        .filter(Boolean),
      status,
      billable_to: billableTo.trim() || null,
      notes: notes.trim() || null,
      hotel_arrangement: hotel,
      with_checklist: !isEdit && withChecklist,
    };
    startTransition(async () => {
      const r = isEdit
        ? await updateTripAction(trip!.id!, input)
        : await createTripAction(input);
      if (r.ok) {
        onClose();
        router.refresh();
      } else {
        setErr(r.message);
      }
    });
  }

  function remove() {
    if (!trip?.id) return;
    if (!armed) {
      setArmed(true);
      return;
    }
    startTransition(async () => {
      const r = await deleteTripAction(trip.id!);
      if (!r.ok) {
        setErr(r.message ?? "Could not delete the trip.");
        return;
      }
      onClose();
      if (onDeleted) onDeleted();
      else router.refresh();
    });
  }

  return (
    <Drawer title={isEdit ? "Edit trip" : "New trip"} onClose={onClose}>
      <div className="space-y-3">
        <Field label="Purpose">
          <div className="flex flex-wrap gap-1.5">
            {PURPOSES.map((p) => (
              <button
                key={p}
                type="button"
                aria-pressed={p === purpose}
                onClick={() => setPurpose(p)}
                className={
                  "press min-h-11 rounded-full border px-3.5 text-sm " +
                  (p === purpose
                    ? "border-accent bg-accent text-white dark:text-neutral-950"
                    : "border-border-strong text-secondary")
                }
              >
                {PURPOSE_LABELS[p]}
              </button>
            ))}
          </div>
        </Field>

        {purpose === "aica" && (
          <p className="rounded-lg border border-brand/30 bg-brand-soft p-2.5 text-xs text-brand-deep">
            AICA:{" "}
            {hotel === "same_day"
              ? "a day return, so no night before."
              : "arrive the night before the session."}{" "}
            {HOTEL_SENTENCES[hotel]} Billable expenses on this trip feed the
            institute reimbursement bill.
          </p>
        )}

        <Field label="Title">
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            className={inputCls}
            placeholder="e.g. AICA session, Rajkot branch"
          />
        </Field>

        <Field label="Work stream">
          <select
            value={streamId}
            onChange={(e) => setStreamId(e.target.value)}
            className={inputCls}
          >
            {workStreams.map((w) => (
              <option key={w.id} value={w.id}>
                {w.name}
              </option>
            ))}
          </select>
        </Field>

        <div className="flex gap-2">
          <Field label="Start date">
            <input
              type="date"
              value={start}
              onChange={(e) => setStart(e.target.value)}
              className={inputCls}
            />
          </Field>
          <Field label="End date">
            <input
              type="date"
              value={end}
              onChange={(e) => setEnd(e.target.value)}
              className={inputCls}
            />
          </Field>
        </div>

        <Field label="Cities (comma separated)">
          <input
            value={cities}
            onChange={(e) => setCities(e.target.value)}
            className={inputCls}
            placeholder="Ahmedabad, Rajkot"
          />
        </Field>

        <Field label="Hotel">
          <div className="grid grid-cols-2 gap-2" role="radiogroup" aria-label="Hotel">
            {HOTEL_ARRANGEMENTS.map((h) => {
              const active = h === hotel;
              return (
                <button
                  key={h}
                  type="button"
                  role="radio"
                  aria-checked={active}
                  onClick={() => setHotelPick(h)}
                  className={
                    "press flex min-h-[56px] flex-col items-center justify-center rounded-xl border px-2 py-2 text-sm " +
                    (active
                      ? "border-brand bg-brand-soft font-semibold text-brand-deep"
                      : "border-border bg-surface text-foreground")
                  }
                >
                  <span>{HOTEL_LABELS[h]}</span>
                  <span className="mt-0.5 text-[11px] text-neutral-500">
                    {HOTEL_HINTS[h]}
                  </span>
                </button>
              );
            })}
          </div>
          <p className="mt-1.5 text-[11px] text-secondary">
            This decides the checklist: a confirmation, a booking, or no hotel
            step at all.
          </p>
        </Field>

        <div className="flex gap-2">
          <Field label="Status">
            <select
              value={status}
              onChange={(e) => setStatus(e.target.value as TripStatus)}
              className={inputCls}
            >
              {STATUS_CHOICES.map((s) => (
                <option key={s} value={s}>
                  {STATUS_LABELS[s]}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Billable to">
            <input
              value={billableTo}
              onChange={(e) => setBillableTo(e.target.value)}
              className={inputCls}
              placeholder="e.g. ICAI Rajkot branch"
            />
          </Field>
        </div>

        <Field label="Notes">
          <textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            className={inputCls}
            rows={2}
          />
        </Field>

        {!isEdit && (
          <label className="flex items-start gap-2 text-sm">
            <input
              type="checkbox"
              checked={withChecklist}
              onChange={(e) => setWithChecklist(e.target.checked)}
              className="mt-1"
            />
            <span>
              Add the standard travel checklist
              <span className="block text-xs text-secondary">
                Book onward, book return, the receipts, the bill, and the
                hotel step the choice above calls for. Dated from this trip,
                each with its own reminder, all under the trip rather than in
                the task list. Needs a start date.
              </span>
            </span>
          </label>
        )}

        {err && <p className="text-sm text-overdue">{err}</p>}

        <div className={drawerFooterCls + " flex gap-2"}>
          <button
            onClick={submit}
            disabled={pending}
            className="press flex-1 rounded-lg bg-accent px-3 py-2 text-sm font-medium text-white disabled:opacity-50 dark:text-neutral-950"
          >
            {pending ? "Saving" : isEdit ? "Save" : "Create"}
          </button>
          {isEdit && (
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
