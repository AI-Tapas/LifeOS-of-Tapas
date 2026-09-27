// B20. A ticket from the travel desk is recorded on its trip, not tasked.
//
// The mail scan runs a second, isolated model turn over mail from allowlisted
// ticket senders (lib/assistant/scan-filters.ts isTicketSender), whose one
// tool is propose_trip_leg. Everything here is pure or dependency-injected,
// relative .ts imports only, so scripts/b20.test.ts proves it offline:
//   validateTripLegProposals  what the model proposed, checked against the
//                             refs actually scanned and the trips he has;
//   pickReceiptExpense        which billable expense the ticket evidences;
//   applyTicketLeg / undoTicketLeg
//                             the write and its exact reversal, the leg and
//                             the receipt link together.
// Audit text built here carries refs, ids and counts only: never a city, a
// PNR or anything else read from the mail.

import { TRANSPORT_MODES, parseLegs, type TransportMode, type TripLeg } from "./core.ts";

export const TICKET_LEG_CAP = 10;
// A ticket may be dated a little outside the trip it belongs to: the night
// before arrival, or a return the morning after.
export const TRIP_DATE_SLACK_DAYS = 2;
export const LEG_REF_MAX = 40;

export interface TicketTrip {
  id: string;
  start_date: string | null;
  end_date: string | null;
  legs: unknown;
}

export interface TicketLeg {
  trip_id: string;
  external_ref: string;
  leg: TripLeg;
}

interface RawCall {
  name: string;
  input: Record<string, unknown>;
}

function shiftKey(dateOnly: string, days: number): string {
  const [y, m, d] = dateOnly.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

function sameLeg(a: TripLeg, b: TripLeg): boolean {
  const k = (s: string) => s.trim().toLowerCase();
  return k(a.from) === k(b.from) && k(a.to) === k(b.to) && a.date === b.date;
}

// The trip a date belongs to: one whose dates contain it first, otherwise one
// within the slack either side. A trip with no start date cannot be matched.
export function tripForDate(trips: TicketTrip[], date: string): TicketTrip | null {
  let near: TicketTrip | null = null;
  for (const t of trips) {
    if (!t.start_date) continue;
    const end = t.end_date ?? t.start_date;
    if (date >= t.start_date && date <= end) return t;
    if (
      !near &&
      date >= shiftKey(t.start_date, -TRIP_DATE_SLACK_DAYS) &&
      date <= shiftKey(end, TRIP_DATE_SLACK_DAYS)
    ) {
      near = t;
    }
  }
  return near;
}

export function validateTripLegProposals(
  calls: RawCall[],
  knownRefs: Set<string>,
  trips: TicketTrip[],
  cap: number = TICKET_LEG_CAP
): { accepted: TicketLeg[]; rejected: string[]; withoutTrip: Set<string> } {
  const accepted: TicketLeg[] = [];
  const rejected: string[] = [];
  const noTrip = new Set<string>();
  const legsByTrip = new Map(trips.map((t) => [t.id, parseLegs(t.legs)]));

  for (const call of calls) {
    if (call.name !== "propose_trip_leg") {
      rejected.push(`tool ${call.name} is not available to the ticket pass`);
      continue;
    }
    const ref = typeof call.input.external_ref === "string" ? call.input.external_ref : "";
    if (!knownRefs.has(ref)) {
      rejected.push(`unknown message ref ${ref ? "given" : "(missing)"}`);
      continue;
    }
    const from = typeof call.input.from_city === "string" ? call.input.from_city.trim() : "";
    const to = typeof call.input.to_city === "string" ? call.input.to_city.trim() : "";
    const date = typeof call.input.date === "string" ? call.input.date.trim() : "";
    if (!from || !to || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      rejected.push(`leg for ${ref} without from, to and a YYYY-MM-DD date`);
      continue;
    }
    const trip = tripForDate(trips, date);
    if (!trip) {
      noTrip.add(ref);
      rejected.push(`leg for ${ref} matches no trip`);
      continue;
    }
    const rawMode = typeof call.input.mode === "string" ? call.input.mode : "";
    const mode: TransportMode = TRANSPORT_MODES.includes(rawMode as TransportMode)
      ? (rawMode as TransportMode)
      : "other";
    const refRaw = typeof call.input.reference === "string" ? call.input.reference : "";
    const pnr = refRaw.replace(/\s+/g, " ").trim().slice(0, LEG_REF_MAX);
    const leg: TripLeg = { from, to, date, mode, cost: null, ...(pnr ? { ref: pnr } : {}) };
    const existing = legsByTrip.get(trip.id) ?? [];
    if (existing.some((l) => sameLeg(l, leg))) {
      rejected.push(`leg for ${ref} is already on trip ${trip.id}`);
      continue;
    }
    if (accepted.length >= cap) {
      rejected.push(`ticket leg cap of ${cap} reached, skipped leg for ${ref}`);
      continue;
    }
    existing.push(leg);
    legsByTrip.set(trip.id, existing);
    accepted.push({ trip_id: trip.id, external_ref: ref, leg });
  }
  // A ticket counts as "without a trip" only when none of its legs landed.
  const withoutTrip = new Set([...noTrip].filter((r) => !accepted.some((a) => a.external_ref === r)));
  return { accepted, rejected, withoutTrip };
}

export interface TicketExpense {
  id: string;
  category: string;
  date: string;
  billable: boolean;
  receipt_ref: string | null;
}

// The billable transport expense on the leg's date that has no receipt yet.
// One at most: a ticket evidences one fare.
export function pickReceiptExpense(expenses: TicketExpense[], leg: TripLeg): string | null {
  const hit = expenses.find(
    (e) =>
      e.billable &&
      e.category === "transport" &&
      e.date === leg.date &&
      !(e.receipt_ref ?? "").trim()
  );
  return hit?.id ?? null;
}

export function receiptRefFor(externalRef: string): string {
  return `email:${externalRef}`;
}

export interface TicketDeps {
  // Appends the leg and returns the legs as they were before, for undo.
  addLeg(tripId: string, leg: TripLeg): Promise<TripLeg[]>;
  listExpenses(tripId: string): Promise<TicketExpense[]>;
  // Sets receipt_ref only while it is still empty; true when it did.
  setReceiptIfEmpty(expenseId: string, receiptRef: string): Promise<boolean>;
}

export interface TicketUndo {
  trip_id: string;
  previous_legs: TripLeg[];
  receipt_links: { expense_id: string; receipt_ref: string }[];
}

export async function applyTicketLeg(deps: TicketDeps, t: TicketLeg): Promise<TicketUndo> {
  const previous = await deps.addLeg(t.trip_id, t.leg);
  const undo: TicketUndo = { trip_id: t.trip_id, previous_legs: previous, receipt_links: [] };
  const expenseId = pickReceiptExpense(await deps.listExpenses(t.trip_id), t.leg);
  if (expenseId) {
    const receiptRef = receiptRefFor(t.external_ref);
    if (await deps.setReceiptIfEmpty(expenseId, receiptRef)) {
      undo.receipt_links.push({ expense_id: expenseId, receipt_ref: receiptRef });
    }
  }
  return undo;
}

export interface TicketUndoDeps {
  setLegs(tripId: string, legs: TripLeg[]): Promise<void>;
  // Clears receipt_ref only while it still holds the value this action set,
  // so a receipt he has since typed over is left alone.
  clearReceiptIf(expenseId: string, receiptRef: string): Promise<void>;
}

export async function undoTicketLeg(deps: TicketUndoDeps, undo: Record<string, unknown>): Promise<void> {
  await deps.setLegs(String(undo.trip_id), parseLegs(undo.previous_legs ?? []));
  const links = Array.isArray(undo.receipt_links) ? undo.receipt_links : [];
  for (const l of links) {
    const r = (l ?? {}) as Record<string, unknown>;
    if (typeof r.expense_id === "string" && typeof r.receipt_ref === "string") {
      await deps.clearReceiptIf(r.expense_id, r.receipt_ref);
    }
  }
}
