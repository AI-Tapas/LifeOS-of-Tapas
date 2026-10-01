// B28. A journey: one continuous trip serving several engagements. Each
// engagement stays its own trips row (a "session" on screen); sessions of one
// journey share trips.journey_id. There is no journeys table, so everything a
// journey shows (its cities, its dates, its sessions in order) is derived here
// from its sessions. Pure and dependency-free, so scripts/b28.test.ts proves
// it offline.

import { tripForDate } from "./ticket.ts";
import { stripHomeCity } from "./core.ts";

export interface JourneySession {
  id: string;
  journey_id?: string | null;
  start_date: string | null;
  end_date: string | null;
  session_date: string | null;
  cities: string[];
}

export type ListEntry<T> =
  | { kind: "trip"; trip: T; start: string | null; end: string | null }
  | { kind: "journey"; journey_id: string; sessions: T[]; start: string | null; end: string | null };

// Travel order: by start date, then session date, then id (stable).
export function orderSessions<T extends JourneySession>(sessions: T[]): T[] {
  return [...sessions].sort(
    (a, b) =>
      (a.start_date ?? "9999").localeCompare(b.start_date ?? "9999") ||
      (a.session_date ?? "").localeCompare(b.session_date ?? "") ||
      a.id.localeCompare(b.id)
  );
}

// Sessions sharing a journey_id fold into one entry; everything else stays a
// plain trip entry, looking exactly as today. A journey_id carried by a single
// trip (the other session was deleted or the join was undone) is not a
// journey: it stays a plain trip.
export function foldJourneys<T extends JourneySession>(trips: T[]): ListEntry<T>[] {
  const byJourney = new Map<string, T[]>();
  for (const t of trips) {
    if (t.journey_id) byJourney.set(t.journey_id, [...(byJourney.get(t.journey_id) ?? []), t]);
  }
  const out: ListEntry<T>[] = [];
  const done = new Set<string>();
  for (const t of trips) {
    const group = t.journey_id ? byJourney.get(t.journey_id)! : null;
    if (!group || group.length < 2) {
      out.push({ kind: "trip", trip: t, start: t.start_date, end: t.end_date ?? t.start_date });
      continue;
    }
    if (done.has(t.journey_id!)) continue;
    done.add(t.journey_id!);
    const sessions = orderSessions(group);
    const starts = sessions.map((x) => x.start_date).filter((d): d is string => !!d);
    const ends = sessions.map((x) => x.end_date ?? x.start_date).filter((d): d is string => !!d);
    out.push({
      kind: "journey",
      journey_id: t.journey_id!,
      sessions,
      start: starts.length ? starts.reduce((a, b) => (a < b ? a : b)) : null,
      end: ends.length ? ends.reduce((a, b) => (a > b ? a : b)) : null,
    });
  }
  return out;
}

// "Bengaluru, Delhi, Surat": the sessions' cities in travel order, home city
// out, a city repeated by the next session said once.
export function journeyCities(sessions: JourneySession[]): string[] {
  const out: string[] = [];
  for (const s of orderSessions(sessions)) {
    for (const c of stripHomeCity(s.cities)) {
      if (out[out.length - 1]?.toLowerCase() !== c.toLowerCase()) out.push(c);
    }
  }
  return out;
}

// The session an expense or ride of this date most likely belongs to: the one
// whose dates hold it, then the nearest session date, tie to the later one.
// Always answers when there is a session (the slack is wide on purpose): it
// only preselects a dropdown.
export function nearestSession<T extends JourneySession>(sessions: T[], date: string): T | null {
  return tripForDate(sessions, date, 3650) ?? orderSessions(sessions)[0] ?? null;
}
