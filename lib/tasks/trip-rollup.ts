// One trip, one line. A task carrying trip_id is travel admin: real work with
// a real due date and a real calendar reminder, but it does not belong in the
// same flat list as "File reply to SCN issued to R N PEB". Thirty-six rows
// became six the day this landed.
//
// The trap this module has to avoid is hiding work, which is the exact
// failure the app exists to prevent. So the rollup is not a folder:
//   - it inherits the rank of its most urgent incomplete step, so an overdue
//     "Book onward ticket" drags the whole trip row into the same band that
//     step would have sat in on its own,
//   - it names that step, so he can see what is being asked without opening
//     anything,
//   - the count is honest ("2 of 5 done"),
//   - a trip whose steps are all done produces no row at all.
//
// Pure, and beside triage.ts on purpose: Home, the Tasks overview and the
// morning brief all call this, so they cannot drift apart.

import { triage, type TriageTask } from "./triage.ts";
import { sessionLine, travelDiffersFromSession, tripDatesLabel } from "../trips/core.ts";

// The statuses that mean "still owed". Matches Home's own task query.
export const OPEN_STATUSES = ["inbox", "todo", "doing"] as const;

export function isOpen(t: { status: string }): boolean {
  return (OPEN_STATUSES as readonly string[]).includes(t.status);
}

export interface RollupTrip {
  id: string;
  title: string;
  start_date: string | null;
  end_date: string | null;
  // The city is what he reads to know which session a line is, now that no
  // branch name is recorded against a trip (M6d).
  cities?: string[] | null;
  // Which session, and the day he actually teaches (M7d). The dates above are
  // the travel span, arrive-the-night-before included, which is precisely
  // what he could not decode at a glance.
  session_label?: string | null;
  session_date?: string | null;
}

// A checklist step as the callers load it: an ordinary task plus the trip it
// hangs off. The trip travels on the row (a PostgREST embed) so nothing has
// to be joined a second time in memory.
export interface TripStep extends TriageTask {
  trip: RollupTrip;
}

export interface TripRollup extends TriageTask {
  kind: "trip";
  trip_id: string;
  // "AICA session, Rajkot, 9 to 10 September 2026"
  label: string;
  done: number;
  total: number;
  // "2 of 5 done"
  progress: string;
  // The step the trip is waiting on, by title.
  next_title: string;
}

// The steps a trip is judged by, best-ranked first. The band order is
// triage's own, so the leading step is exactly the one that would have led
// the list if the steps were still loose rows.
function leadingStep<T extends TriageTask>(open: T[], nowMs: number): T | null {
  const bands = triage(open, nowMs);
  return (
    bands.do_first[0] ?? bands.important[0] ?? bands.urgent[0] ?? bands.later[0] ?? null
  );
}

// Every trip that still owes a step, as one ranked row each. Trips with
// nothing left drop out entirely rather than sitting there looking finished.
export function rollUpTrips(steps: TripStep[], nowMs: number): TripRollup[] {
  const byTrip = new Map<string, TripStep[]>();
  for (const s of steps) {
    const list = byTrip.get(s.trip.id);
    if (list) list.push(s);
    else byTrip.set(s.trip.id, [s]);
  }

  const out: TripRollup[] = [];
  for (const [tripId, all] of byTrip) {
    const open = all.filter(isOpen);
    const done = all.filter((s) => s.status === "done");
    // Dropped steps leave the denominator: he decided that one was not owed,
    // so counting it would make the trip look permanently unfinished.
    const total = open.length + done.length;
    if (open.length === 0 || total === 0) continue;

    const lead = leadingStep(open, nowMs);
    if (!lead) continue;
    const trip = all[0].trip;
    const dates = tripDatesLabel(trip.start_date, trip.end_date);
    // When the session leads, the long title is not in the label at all, so
    // the city is never a repeat and is always worth showing. Only the
    // title-led fallback needs the de-duplication tripCityLabel does.
    const session = sessionLine(trip.session_label ?? null, trip.session_date ?? null);
    const showTravel = travelDiffersFromSession(
      trip.start_date,
      trip.end_date,
      trip.session_date ?? null
    );
    const city = session
      ? (trip.cities ?? []).filter(Boolean).join(", ")
      : tripCityLabel(trip);

    out.push({
      kind: "trip",
      // Synthetic, and deliberately not a uuid: nothing may mistake a rollup
      // for a task and try to complete it.
      id: `trip:${tripId}`,
      trip_id: tripId,
      title: trip.title,
      // Same order as the trips list: the session first, then the city, then
      // the travel span only when it says something the session date does
      // not. "L1D2 - 4 Sept, Bangalore" beats the old
      // "AICA Level 1 batch 912, KPMG Bangalore, 3 to 5 September 2026",
      // which made him stop and work out which day he was teaching.
      label: [
        session || trip.title,
        city,
        session && !showTravel ? "" : dates === "No dates yet" ? "" : dates,
      ]
        .filter(Boolean)
        .join(", "),
      // Rank inherited whole from the leading step, so the trip sits in the
      // band that step earned, no higher and no lower.
      priority: lead.priority,
      due_ts: lead.due_ts,
      status: "todo",
      done: done.length,
      total,
      progress: `${done.length} of ${total} done`,
      next_title: lead.title,
    });
  }
  return out;
}

// The split every ranked surface needs: the tasks that stand on their own,
// and one row per trip. `tasks` may contain checklist steps; they are taken
// out here and represented by their trip instead.
export function splitTripTasks<T extends TriageTask & { trip_id: string | null }>(
  tasks: T[],
  steps: TripStep[],
  nowMs: number
): { standalone: T[]; rollups: TripRollup[] } {
  return {
    standalone: tasks.filter((t) => !t.trip_id),
    rollups: rollUpTrips(steps, nowMs),
  };
}

// The city, unless the title already carries it. Titles are free text he
// writes himself ("AICA session, Rajkot branch"), so naming Rajkot twice on
// one line reads worse than not naming it at all.
// ponytail: a case-insensitive substring test, not a place-name matcher. If a
// title ever names a different city than the field, both appear; that is the
// honest outcome anyway.
export function tripCityLabel(trip: RollupTrip): string {
  const cities = (trip.cities ?? []).filter(Boolean);
  if (!cities.length) return "";
  const title = trip.title.toLowerCase();
  const fresh = cities.filter((c) => !title.includes(c.toLowerCase()));
  return fresh.join(", ");
}
