// The standard travel checklist: the five steps Tapas runs for every
// outstation trip, derived from the trip's own dates. Pure and
// dependency-free (only the shared date helpers), so scripts/m6b.test.ts can
// prove the dates offline and so ONE implementation serves the add-trip
// drawer, the trip screen and the connector tool. There is no second copy.
//
// A step is an ordinary task carrying trip_id. That is deliberate: it keeps
// the due date, the priority, the undo path and the Google Calendar reminder
// that a bespoke checklist row would have thrown away.

// Relative .ts imports so node --test (type stripping, no bundler) resolves
// them, the same convention lib/tasks/triage.ts and lib/trips/bill.ts use.
import { addDays, civilKey, type CivilDate } from "../datetime.ts";
import { TRANSPORT_HELP } from "./bill.ts";

export interface ChecklistTrip {
  title: string;
  purpose: string; // trip_purpose: aica | conference | leisure | other
  start_date: string | null;
  end_date: string | null;
  billable_to: string | null;
}

export interface ChecklistStep {
  key: string;
  title: string;
  note: string;
  due_date: string; // YYYY-MM-DD, IST calendar date
}

// YYYY-MM-DD to the civil date the shared helpers work in.
function civilOf(dateOnly: string): CivilDate {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateOnly);
  if (!m) throw new Error(`Invalid date: ${dateOnly}`);
  return { y: Number(m[1]), m: Number(m[2]), d: Number(m[3]) };
}

// A due date in the past is useless: the reminder has already gone by. Clamp
// it to today so a trip entered late still produces a list he can work.
function shift(base: string, days: number, todayKey: string): string {
  const key = civilKey(addDays(civilOf(base), days));
  return key < todayKey ? todayKey : key;
}

// The standard list. Ordered as he works it, which is also date order.
export function buildChecklist(
  trip: ChecklistTrip,
  todayKey: string
): ChecklistStep[] {
  // Without a start date there is nothing to count back from, so the app
  // offers no list rather than guessing dates that would chase him wrongly.
  if (!trip.start_date) return [];
  const start = trip.start_date;
  const end = trip.end_date ?? start;
  const isAica = trip.purpose === "aica";
  // Only a trip somebody reimburses ends in a bill. For AICA that is always
  // the institute; otherwise it takes an explicit payer.
  const billable = isAica || !!trip.billable_to;
  const context = `Trip: ${trip.title}.`;

  const steps: ChecklistStep[] = [
    {
      key: "onward",
      title: "Book onward ticket",
      note: `${context} ${TRANSPORT_HELP} Arrive the night before.`,
      due_date: shift(start, -7, todayKey),
    },
    {
      key: "return",
      title: "Book return ticket",
      note: `${context} ${TRANSPORT_HELP}`,
      due_date: shift(start, -7, todayKey),
    },
    {
      key: "hotel",
      title: isAica ? "Confirm hotel with the branch" : "Confirm the hotel",
      note: isAica
        ? `${context} The branch usually arranges the hotel, so this is a confirmation, not a booking.`
        : context,
      due_date: shift(start, -5, todayKey),
    },
    {
      key: "receipts",
      title: "Collect and keep travel receipts",
      note: `${context} Keep the receipts themselves wherever you file them; the app records a reference only.`,
      due_date: shift(end, 0, todayKey),
    },
  ];

  if (billable) {
    steps.push({
      key: "bill",
      title: "Build the reimbursement bill",
      note: `${context} Built from the trip's billable expenses${
        trip.billable_to ? `, addressed to ${trip.billable_to}` : ""
      }.`,
      due_date: shift(end, 2, todayKey),
    });
  }

  return steps;
}
