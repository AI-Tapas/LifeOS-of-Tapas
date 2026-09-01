// The standard travel checklist: the steps Tapas runs for every outstation
// trip, derived from the trip's own dates and from how the hotel is arranged.
// Pure and dependency-free (only the shared date helpers), so
// scripts/m6b.test.ts and scripts/m6c.test.ts can prove the dates offline and
// so ONE implementation serves the add-trip drawer, the trip screen and the
// connector tool. There is no second copy.
//
// No step builds a bill. Tapas invoices monthly to the ICAI AI committee,
// never per trip (M6d), so the reimbursement lives in one recurring monthly
// task and in the month pack at /trips/month.
//
// A step is an ordinary task carrying trip_id. That is deliberate: it keeps
// the due date, the priority, the undo path and the Google Calendar reminder
// that a bespoke checklist row would have thrown away.

// Relative .ts imports so node --test (type stripping, no bundler) resolves
// them, the same convention lib/tasks/triage.ts and lib/trips/core.ts use.
import { addDays, civilKey, type CivilDate } from "../datetime.ts";
import { TRANSPORT_HELP } from "./core.ts";
import type { ReminderMode } from "../reminders/core.ts";

// Mirrors the hotel_arrangement enum (migration 20260901000100).
export type HotelArrangement = "branch" | "self" | "relative" | "same_day";
// Mirrors the trip_purpose enum. Declared here rather than imported so this
// module stays free of generated types and node --test can load it.
export type TripPurpose = "aica" | "conference" | "leisure" | "other";

export const HOTEL_ARRANGEMENTS: HotelArrangement[] = [
  "branch",
  "self",
  "relative",
  "same_day",
];

export const HOTEL_LABELS: Record<HotelArrangement, string> = {
  branch: "Branch books",
  self: "I book",
  relative: "With family",
  same_day: "Same day",
};

export const HOTEL_HINTS: Record<HotelArrangement, string> = {
  branch: "The branch arranges it",
  self: "Mine to book, reimbursable",
  relative: "No booking, no cost",
  same_day: "Back the same day",
};

// The one line the trip screen states near the dates.
export const HOTEL_SENTENCES: Record<HotelArrangement, string> = {
  branch: "Hotel: the branch arranges it.",
  self: "Hotel: yours to book, and it is reimbursable.",
  relative: "Staying with family. No hotel to arrange.",
  same_day: "Returning the same day. No hotel at all.",
};

export interface ChecklistTrip {
  title: string;
  purpose: string; // trip_purpose: aica | conference | leisure | other
  start_date: string | null;
  end_date: string | null;
  // trip_bills_to: icai_monthly | chapter_aed | none
  bills_to: string;
  cities: string[];
  // Null on every row written before milestone 6c, and on any trip he has not
  // answered for. Resolved, never guessed at write time: see below.
  hotel_arrangement?: HotelArrangement | null;
}

export interface ChecklistStep {
  key: string;
  title: string;
  note: string;
  due_date: string; // YYYY-MM-DD, IST calendar date
  // Whether this step interrupts him on the calendar (M7a). Travel admin is
  // routine work he does in a batch, and the trip screen and the morning
  // brief already chase it, so every ordinary step is 'in_app'. The overseas
  // chapter AED invoice is the exception: once or twice a year, and
  // forgetting it is the risk he named.
  reminder_mode: ReminderMode;
}

// What a new trip starts on. An ICAI branch arranges his hotel on almost
// every trip, whatever its purpose; the exception is an industry batch held
// at a company site, where he books his own. That is one or two trips a
// month against ten or more, so the app defaults to the norm and he corrects
// the exception, not the other way round.
//
// The purpose is deliberately NOT consulted. Industry batches have no purpose
// of their own yet, and guessing one from a trip's title would be worse than
// letting him tap the control.
//
// One exception, which is not really a hotel question: a trip that starts and
// ends on the same date is a day return, so there is nothing to arrange.
export function defaultHotelArrangement(
  startDate: string | null,
  endDate: string | null,
  purpose?: TripPurpose | null
): HotelArrangement {
  if (startDate && endDate && startDate === endDate) return "same_day";
  // Nobody arranges a hotel for his holiday. Branch-arranged is the norm for
  // every kind of WORK trip, which is the rule he gave; leisure was the one
  // case where following it literally read as nonsense on the screen.
  if (purpose === "leisure") return "self";
  return "branch";
}

// Reading a stored trip. A null column is not a missing answer to chase: it
// is a trip written before the column existed, and it reads as the norm,
// which is the branch arranging it. The dates are deliberately NOT consulted
// here, so an old row never silently reads as same_day.
export function resolveHotelArrangement(trip: {
  hotel_arrangement?: HotelArrangement | null;
}): HotelArrangement {
  return trip.hotel_arrangement ?? "branch";
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
  const hotel = resolveHotelArrangement(trip);
  const context = `Trip: ${trip.title}.`;

  const steps: ChecklistStep[] = [
    {
      key: "onward",
      title: "Book onward ticket",
      // A day return does not arrive the night before, so the line that tells
      // him to would be wrong instruction, not a harmless extra.
      note:
        hotel === "same_day"
          ? `${context} ${TRANSPORT_HELP} Back the same day, so no overnight stay.`
          : `${context} ${TRANSPORT_HELP} Arrive the night before.`,
      due_date: shift(start, -7, todayKey),
      reminder_mode: "in_app",
    },
    {
      key: "return",
      title: "Book return ticket",
      note: `${context} ${TRANSPORT_HELP}`,
      due_date: shift(start, -7, todayKey),
      reminder_mode: "in_app",
    },
  ];

  // The hotel step exists only when there is a hotel. Staying with family or
  // coming home the same night means no step at all, not a step he has to
  // dismiss every trip.
  const hotelStep = buildHotelStep(hotel, context, start, todayKey);
  if (hotelStep) steps.push(hotelStep);

  steps.push({
    key: "receipts",
    title: "Collect and keep travel receipts",
    note: `${context} Keep the receipts themselves wherever you file them; the app records a reference only.`,
    due_date: shift(end, 0, todayKey),
    reminder_mode: "in_app",
  });

  // A monthly ICAI trip ends in no step of its own: it feeds the one
  // recurring "Raise the AICA invoice for last month" task, seeded by
  // migration 20260901000300. Only an overseas chapter needs a reminder here,
  // because that invoice is raised separately, in AED, once or twice a year,
  // and the stated risk is forgetting it altogether.
  if (trip.bills_to === "chapter_aed") {
    const city = trip.cities[0] ?? "";
    steps.push({
      key: "aed",
      title: `Raise the AED invoice to the ${city || "overseas"} chapter`,
      note:
        `${context} This trip is NOT on the monthly ICAI claim. ` +
        "It is invoiced separately to the chapter, in AED.",
      due_date: shift(end, 3, todayKey),
      // The one step that earns a calendar interrupt: once or twice a year,
      // and he named forgetting it as the specific risk.
      reminder_mode: "calendar",
    });
  }

  return steps;
}

// The hotel step, or none. Split out because the trip screen also needs to
// ask "what should this trip's hotel step be now?" after he changes the
// arrangement, without rebuilding the whole list.
export function buildHotelStep(
  hotel: HotelArrangement,
  context: string,
  startDate: string,
  todayKey: string
): ChecklistStep | null {
  if (hotel === "branch") {
    return {
      key: "hotel",
      title: "Confirm hotel with the branch",
      note: `${context} The branch usually arranges the hotel, so this is a confirmation, not a booking.`,
      // A confirmation is a chase, not a booking, so it sits closer in.
      due_date: shift(startDate, -5, todayKey),
      reminder_mode: "in_app",
    };
  }
  if (hotel === "self") {
    return {
      key: "hotel",
      title: "Book hotel",
      note: `${context} Yours to book, so it goes with the tickets: later is dearer. Keep it as a billable expense.`,
      // Alongside the tickets: his own booking, and waiting costs money.
      due_date: shift(startDate, -7, todayKey),
      reminder_mode: "in_app",
    };
  }
  return null;
}

// Every title the app has ever given the hotel step. The trip screen uses
// this to tell "the step the app wrote" from "a step he has since rewritten",
// and only ever touches the former.
export const HOTEL_STEP_TITLES = [
  "Confirm hotel with the branch",
  "Confirm the hotel", // pre-6c wording for a non-AICA trip
  "Book hotel",
];

export const ONWARD_STEP_TITLE = "Book onward ticket";
