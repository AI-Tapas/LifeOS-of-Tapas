// B21. A cab receipt from Ola, Uber, Rapido or Bharat Taxi becomes a billable
// transport expense on the AICA trip the ride belongs to.
//
// The mail scan runs a third isolated turn over mail from the cab receipt
// allowlist (lib/assistant/scan-filters.ts CAB_RECEIPT_SENDERS), whose one
// tool is propose_cab_expense. Everything here is pure, relative .ts imports
// only, so scripts/b21.test.ts proves it offline:
//   validateCabProposals  what the model proposed, checked against the refs
//                         scanned, the sender, the trips and earlier rides;
//   cabExpenseInput       the add_trip_expense performer's input;
//   cabBriefLine          the one line the morning brief carries.
// A ride that matches no trip is a personal ride: nothing about it is kept,
// not even in a rejection reason, only a count.

import { tripForDate, receiptRefFor, type TicketTrip } from "./ticket.ts";
import { CAB_PROVIDER_NAMES, type CabProvider } from "../assistant/scan-filters.ts";

export const CAB_RIDE_CAP = 20;
// A local ride sits inside the trip; a day either side covers the airport
// drop the evening before and the pick-up the morning after.
export const CAB_TRIP_SLACK_DAYS = 1;
export const CAB_DUPLICATE_MINUTES = 10;
export const BOOKING_ID_MAX = 40;
const AREA_MAX = 30;
// ponytail: a sanity ceiling on one local ride, not a policy. A higher
// figure is a misread total; raise it if a real ride ever costs more.
const RIDE_AMOUNT_MAX = 20000;

export interface CabTrip extends TicketTrip {
  title: string;
  cities: unknown;
}

export interface CabRide {
  trip_id: string;
  trip_label: string;
  external_ref: string;
  provider: CabProvider;
  from_area: string | null;
  to_area: string | null;
  amount: number;
  date: string; // YYYY-MM-DD, IST
  time: string; // HH:MM, IST
  booking_id: string | null;
}

// What an earlier scanned ride left on its assistant_actions row, for the
// duplicate check.
export interface PriorCab {
  trip_id: string;
  provider: string;
  booking_id: string | null;
  amount: number;
  date: string;
  time: string;
}

interface RawCall {
  name: string;
  input: Record<string, unknown>;
}

// "Airport", "Hotel", "Terminal 2": an area, never a street address. The
// part before the first comma, and nothing carrying a house number, pin code
// or phone number (four or more digits in a row).
export function cleanArea(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const first = raw.split(",")[0].replace(/\s+/g, " ").trim();
  if (!first || /\d{4,}/.test(first)) return null;
  return first.slice(0, AREA_MAX).trim() || null;
}

export function tripLabel(trip: { title: string; cities: unknown }): string {
  const cities = Array.isArray(trip.cities) ? trip.cities.filter((c) => typeof c === "string" && c.trim()) : [];
  return (cities[0] as string | undefined)?.trim() || trip.title;
}

function minutesOf(date: string, time: string): number {
  const [y, m, d] = date.split("-").map(Number);
  const [h, min] = time.split(":").map(Number);
  return Date.UTC(y, m - 1, d, h, min) / 60000;
}

export function isDuplicateRide(a: PriorCab, b: PriorCab): boolean {
  if (a.trip_id !== b.trip_id) return false;
  if (a.booking_id && b.booking_id && a.provider === b.provider && a.booking_id === b.booking_id) return true;
  return a.amount === b.amount && Math.abs(minutesOf(a.date, a.time) - minutesOf(b.date, b.time)) <= CAB_DUPLICATE_MINUTES;
}

export function validateCabProposals(
  calls: RawCall[],
  // Each scanned ref and the provider its sender belongs to.
  senders: Map<string, CabProvider>,
  trips: CabTrip[],
  prior: PriorCab[] = [],
  cap: number = CAB_RIDE_CAP
): { accepted: CabRide[]; rejected: string[]; personal: number; wellFormedRefs: Set<string> } {
  const accepted: CabRide[] = [];
  const rejected: string[] = [];
  const wellFormedRefs = new Set<string>();
  let personal = 0;

  for (const call of calls) {
    if (call.name !== "propose_cab_expense") {
      rejected.push(`tool ${call.name} is not available to the cab receipt pass`);
      continue;
    }
    const i = call.input;
    const ref = typeof i.external_ref === "string" ? i.external_ref : "";
    const provider = senders.get(ref);
    if (!provider) {
      rejected.push(`unknown message ref ${ref ? "given" : "(missing)"}`);
      continue;
    }
    // The sender decides the provider; a proposal naming another is refused.
    if (i.provider !== provider) {
      rejected.push(`ride for ${ref} names a provider other than its sender`);
      continue;
    }
    const date = typeof i.ride_date === "string" ? i.ride_date.trim() : "";
    const time = typeof i.ride_time === "string" ? i.ride_time.trim() : "";
    const amount = typeof i.amount === "number" ? Math.round(i.amount * 100) / 100 : NaN;
    if (
      !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
      !/^([01]\d|2[0-3]):[0-5]\d$/.test(time) ||
      !(amount > 0 && amount <= RIDE_AMOUNT_MAX)
    ) {
      rejected.push(`ride for ${ref} without a YYYY-MM-DD date, an HH:MM time and an amount`);
      continue;
    }
    wellFormedRefs.add(ref);
    const trip = tripForDate(trips, date, CAB_TRIP_SLACK_DAYS);
    if (!trip) {
      // A personal ride. Counted, nothing else: no ref, no date, no place.
      personal += 1;
      continue;
    }
    const bookingRaw = typeof i.booking_id === "string" ? i.booking_id.replace(/\s+/g, " ").trim() : "";
    const ride: CabRide = {
      trip_id: trip.id,
      trip_label: tripLabel(trip),
      external_ref: ref,
      provider,
      from_area: cleanArea(i.from_area),
      to_area: cleanArea(i.to_area),
      amount,
      date,
      time,
      booking_id: bookingRaw ? bookingRaw.slice(0, BOOKING_ID_MAX) : null,
    };
    if ([...prior, ...accepted].some((p) => isDuplicateRide(p, ride))) {
      rejected.push(`ride for ${ref} is already on trip ${trip.id}`);
      continue;
    }
    if (accepted.length >= cap) {
      rejected.push(`cab ride cap of ${cap} reached, skipped a ride for ${ref}`);
      continue;
    }
    accepted.push(ride);
  }
  return { accepted, rejected, personal, wellFormedRefs };
}

// What the receipt turn is shown of one mail. The body only where no PDF gave
// text: Uber's receipt is the body; Ola's, Rapido's and Bharat Taxi's is the
// PDF, and their body is a covering note.
export function cabReceiptMail(
  m: { ref: string; from: string; subject: string; date: string },
  read: { body: string; attachments: { name: string; text: string | null }[] }
): {
  ref: string;
  from: string;
  subject: string;
  date: string;
  body: string;
  attachments: { name: string; text: string | null; route: string | null }[];
} {
  const pdfs = read.attachments.filter((a) => a.text);
  return {
    ...m,
    body: pdfs.length ? "" : read.body,
    attachments: pdfs.map((a) => ({ name: a.name, text: a.text, route: null })),
  };
}

// "Uber, Airport to Hotel".
export function cabDescription(r: Pick<CabRide, "provider" | "from_area" | "to_area">): string {
  const name = CAB_PROVIDER_NAMES[r.provider];
  if (r.from_area && r.to_area) return `${name}, ${r.from_area} to ${r.to_area}`;
  if (r.from_area || r.to_area) return `${name}, ${r.from_area ?? r.to_area}`;
  return `${name} ride`;
}

// The existing add_trip_expense performer's input. Transport is the enum
// value for travel of every kind, local cabs included.
export function cabExpenseInput(r: CabRide): Record<string, unknown> {
  return {
    trip_id: r.trip_id,
    category: "transport",
    amount: r.amount,
    date: r.date,
    billable: true,
    receipt_ref: receiptRefFor(r.external_ref),
  };
}

// What the assistant_actions row keeps: the expense fields and nothing read
// from the receipt beyond them.
export function cabActionPayload(r: CabRide): PriorCab & { via: "cab_receipt"; external_ref: string } {
  return {
    via: "cab_receipt",
    trip_id: r.trip_id,
    external_ref: r.external_ref,
    provider: r.provider,
    booking_id: r.booking_id,
    amount: r.amount,
    date: r.date,
    time: r.time,
  };
}

export function priorFromPayload(p: unknown): PriorCab | null {
  const r = (p ?? {}) as Record<string, unknown>;
  if (r.via !== "cab_receipt" || typeof r.trip_id !== "string" || typeof r.amount !== "number") return null;
  if (typeof r.date !== "string" || typeof r.time !== "string") return null;
  return {
    trip_id: r.trip_id,
    provider: String(r.provider ?? ""),
    booking_id: typeof r.booking_id === "string" ? r.booking_id : null,
    amount: r.amount,
    date: r.date,
    time: r.time,
  };
}

const rupees = (n: number) =>
  `Rs ${new Intl.NumberFormat("en-IN", { maximumFractionDigits: 2 }).format(n)}`;

// "4 cab receipts added to the Kolkata trip (Rs 1,240)." Personal rides are
// never mentioned. A Bharat Taxi invoice whose rides could not be told apart
// gets its own sentence.
export function cabBriefLine(
  added: { label: string; count: number; amount: number }[],
  unsplit = 0
): string | null {
  const byLabel = new Map<string, { count: number; amount: number }>();
  for (const a of added) {
    const cur = byLabel.get(a.label) ?? { count: 0, amount: 0 };
    byLabel.set(a.label, { count: cur.count + a.count, amount: Math.round((cur.amount + a.amount) * 100) / 100 });
  }
  const parts: string[] = [];
  const trips = [...byLabel].map(
    ([label, t]) => `${t.count} cab ${t.count === 1 ? "receipt" : "receipts"} added to the ${label} trip (${rupees(t.amount)})`
  );
  if (trips.length) parts.push(`${trips.join("; ")}.`);
  if (unsplit > 0) {
    parts.push(
      `${unsplit} Bharat Taxi ${unsplit === 1 ? "receipt" : "receipts"} could not be split into rides, so nothing was added from ${unsplit === 1 ? "it" : "them"}.`
    );
  }
  return parts.length ? parts.join(" ") : null;
}
