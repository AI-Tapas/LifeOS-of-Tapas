// B29. The family travel calendar: what Life OS writes to it, and the plan for
// keeping it right. Pure, relative imports only, so scripts/b29.test.ts proves
// it offline with Google mocked.
//
// THE PRIVACY RULE (Tapas's own words, 1 October 2026), the most important
// line in this file:
//   She sees the city, the session days, and each leg's mode, time and route.
//   Nothing else: no PNRs or booking references, no hotel details, no client or
//   organisation names (not ICAI, not Cygnet, not the trip title, notes, work
//   stream, purpose or session label), no amounts.
//
// How that is enforced: the event builders below read ONLY a session date, the
// first city, and each leg's from, to, date, mode and time. They never read a
// trip's title, notes, work stream, purpose, session label or a leg's ref or
// cost, so there is nothing to leak by accident. On top of that, a place name
// that itself carries an organisation or hotel word is WITHHELD (the event is
// not written at all) rather than printed: privacy beats completeness.

import { createHash } from "node:crypto";
import { parseLegs, stripHomeCity, type TransportMode, type TripLeg } from "../trips/core.ts";

export const FAMILY_WINDOW_DAYS = 120;
// Past events stay for this many days, so a leg does not vanish the morning
// after it, in the middle of a trip.
export const FAMILY_PAST_DAYS = 30;

// Words that must never reach the family calendar. Matched as substrings,
// case-insensitive, on the raw place text. The test uses the same list. A work
// stream's name is added at run time (see safePlace).
export const FORBIDDEN_WORDS = [
  "icai", "aica", "cygnet", "hotel", "inn", "resort", "residency", "suites",
  "marriott", "taj", "itc", "novotel", "hyatt", "lemon tree", "ginger",
  "fortune", "radisson", "oyo", "office", "bhavan", "institute", "chapter",
  "branch", "client", "guest house",
] as const;

const MODE_WORD: Record<TransportMode, string> = {
  vande_bharat: "Train",
  tejas: "Train",
  ac_sleeper: "Train",
  cab: "Cab",
  flight: "Flight",
  other: "Travel",
};

// Only these fields of a trip are ever read. The type is deliberately narrow:
// a caller may pass a whole row, and everything else on it is ignored.
export interface FamilyTrip {
  id: string;
  status: string;
  session_date: string | null;
  cities: unknown;
  legs: unknown;
}

export interface FamilyEventPayload {
  summary: string;
  start: { date: string } | { dateTime: string; timeZone: string };
  end: { date: string } | { dateTime: string; timeZone: string };
  transparency?: "transparent";
  // No reminders at all: she is not nagged about his flights.
  reminders: { useDefault: false; overrides: [] };
}

export interface DesiredEvent {
  trip_id: string;
  kind: "session" | "leg";
  item_key: string;
  payload: FamilyEventPayload;
  hash: string;
}

export interface RecordedEvent {
  id: string;
  trip_id: string | null;
  kind: string;
  item_key: string;
  ext_event_id: string;
  ext_calendar_id: string;
  content_hash: string;
}

function isDateKey(v: unknown): v is string {
  return typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v);
}

function shiftDay(dateKey: string, days: number): string {
  const [y, m, d] = dateKey.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

// Place names are free text, so a place is made safe by construction:
//   1. anything containing a forbidden word or a work stream name is refused;
//   2. anything containing a digit is refused;
//   3. everything after a comma or an opening square or curly bracket goes;
//   4. a round bracket is kept only when it holds one or two plain words
//      ("Ahmedabad (Ambli Road)"), else it goes;
//   5. more than three words is refused.
// null means withheld: the caller uses travel wording without the place.
export function safePlace(raw: string, streamNames: readonly string[] = []): string | null {
  const lower = raw.toLowerCase();
  if (FORBIDDEN_WORDS.some((w) => lower.includes(w))) return null;
  if (streamNames.some((s) => s.trim().length >= 2 && lower.includes(s.trim().toLowerCase()))) return null;
  if (/\d/.test(raw)) return null;
  const head = raw.split(/[,\[\]{}<>]/)[0].trim();
  const m = /^([^(]*)\(([^)]*)(\)?)/.exec(head);
  let base = head;
  if (m) {
    base = m[1].trim();
    const inner = m[2].trim();
    if (m[3] === ")" && /^\p{L}+( \p{L}+)?$/u.test(inner)) base = `${base} (${inner})`;
  }
  base = base.replace(/\s+/g, " ").trim();
  if (!base || base.split(" ").length > 3) return null;
  return base;
}

function firstCity(cities: unknown, streamNames: readonly string[]): string | null {
  const list = Array.isArray(cities) ? cities.filter((c): c is string => typeof c === "string") : [];
  const city = stripHomeCity(list).map((c) => c.trim()).find((c) => c);
  return city ? safePlace(city, streamNames) : null;
}

// "2026-10-07" + "19:00" + 120 minutes, as IST wall-clock strings.
function addMinutes(dateKey: string, hhmm: string, minutes: number): { date: string; time: string } {
  const [y, m, d] = dateKey.split("-").map(Number);
  const [h, mi] = hhmm.split(":").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d, h, mi + minutes));
  const p = (n: number) => String(n).padStart(2, "0");
  return {
    date: `${t.getUTCFullYear()}-${p(t.getUTCMonth() + 1)}-${p(t.getUTCDate())}`,
    time: `${p(t.getUTCHours())}:${p(t.getUTCMinutes())}`,
  };
}

function allDay(summary: string, dateKey: string): FamilyEventPayload {
  return {
    summary,
    start: { date: dateKey },
    end: { date: shiftDay(dateKey, 1) },
    transparency: "transparent",
    reminders: { useDefault: false, overrides: [] },
  };
}

export function legEvent(leg: TripLeg, streamNames: readonly string[] = []): FamilyEventPayload | null {
  if (!leg.from.trim() || !leg.to.trim() || !isDateKey(leg.date)) return null;
  const from = safePlace(leg.from, streamNames);
  const to = safePlace(leg.to, streamNames);
  const word = MODE_WORD[leg.mode];
  // A withheld place falls back to travel wording: "Flight to Surat", "Flight".
  const title = from && to ? `${word} ${from} to ${to}` : to ? `${word} to ${to}` : from ? `${word} from ${from}` : word;
  if (!leg.time) return allDay(`${title} (time to be confirmed)`, leg.date);
  const end = addMinutes(leg.date, leg.time, leg.mode === "flight" ? 120 : 60);
  return {
    summary: title,
    start: { dateTime: `${leg.date}T${leg.time}:00+05:30`, timeZone: "Asia/Kolkata" },
    end: { dateTime: `${end.date}T${end.time}:00+05:30`, timeZone: "Asia/Kolkata" },
    reminders: { useDefault: false, overrides: [] },
  };
}

// PATCH merges objects, so an event that turns from all-day to timed (or back)
// would carry both a date and a dateTime and Google refuses it. The body names
// the unused field as null, and transparency is always stated.
export function familyPatchBody(p: FamilyEventPayload): Record<string, unknown> {
  const side = (x: FamilyEventPayload["start"]) =>
    "date" in x
      ? { date: x.date, dateTime: null, timeZone: null }
      : { dateTime: x.dateTime, timeZone: x.timeZone, date: null };
  return { ...p, start: side(p.start), end: side(p.end), transparency: p.transparency ?? "opaque" };
}

function hashOf(payload: FamilyEventPayload): string {
  return createHash("sha256").update(JSON.stringify(payload), "utf8").digest("hex");
}

// The whole desired set: trips and legs from 30 days before today (IST date
// key) to 120 days after it, cancelled trips excluded.
export function desiredFamilyEvents(
  trips: FamilyTrip[],
  todayKey: string,
  streamNames: readonly string[] = []
): DesiredEvent[] {
  const first = shiftDay(todayKey, -FAMILY_PAST_DAYS);
  const last = shiftDay(todayKey, FAMILY_WINDOW_DAYS);
  const inWindow = (d: string) => d >= first && d <= last;
  const out: DesiredEvent[] = [];
  const push = (trip_id: string, kind: "session" | "leg", item_key: string, payload: FamilyEventPayload) =>
    out.push({ trip_id, kind, item_key, payload, hash: hashOf(payload) });

  for (const t of trips) {
    if (t.status === "cancelled") continue;
    const city = firstCity(t.cities, streamNames);
    if (city && isDateKey(t.session_date) && inWindow(t.session_date)) {
      push(t.id, "session", t.session_date, allDay(`In ${city} (full day)`, t.session_date));
    }
    // The key is the date, the route and an occurrence number among identical
    // ones, NOT the leg's position: removing one leg then deletes only its own
    // event instead of shifting every later leg's key.
    const seen = new Map<string, number>();
    for (const leg of parseLegs(t.legs)) {
      if (!isDateKey(leg.date)) continue;
      const base = `${leg.date}|${leg.from.trim().toLowerCase()}|${leg.to.trim().toLowerCase()}`;
      const n = (seen.get(base) ?? 0) + 1;
      seen.set(base, n);
      if (!inWindow(leg.date)) continue;
      const payload = legEvent(leg, streamNames);
      if (payload) push(t.id, "leg", `${base}|${n}`, payload);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// The plan and its execution. Only events recorded in family_travel_events are
// ever updated or deleted; an event on the calendar that Life OS did not write
// is not in `recorded`, so nothing here can name it.
// ---------------------------------------------------------------------------
const keyOf = (r: { trip_id: string | null; kind: string; item_key: string }) =>
  `${r.trip_id ?? "-"}|${r.kind}|${r.item_key}`;

export interface FamilyPlan {
  create: DesiredEvent[];
  update: { desired: DesiredEvent; recorded: RecordedEvent }[];
  remove: RecordedEvent[];
}

export function planFamilySync(
  desired: DesiredEvent[],
  recorded: RecordedEvent[],
  calendarId: string
): FamilyPlan {
  const have = new Map(recorded.map((r) => [keyOf(r), r]));
  const want = new Set(desired.map(keyOf));
  const plan: FamilyPlan = { create: [], update: [], remove: [] };
  for (const d of desired) {
    const r = have.get(keyOf(d));
    if (!r) plan.create.push(d);
    // An event recorded on another calendar is moved: removed there, made here.
    else if (r.content_hash !== d.hash || r.ext_calendar_id !== calendarId) plan.update.push({ desired: d, recorded: r });
  }
  for (const r of recorded) if (!want.has(keyOf(r))) plan.remove.push(r);
  return plan;
}

// Everything the executor needs from the outside world, injected so the test
// can use an in-memory calendar.
export interface FamilyIO {
  // Creates on the CURRENT family calendar.
  create(payload: FamilyEventPayload): Promise<string>;
  // Patch and remove always name the calendar the event was recorded on.
  // patch is false when the event is already gone (404 or 410).
  patch(calendarId: string, extEventId: string, payload: FamilyEventPayload): Promise<boolean>;
  remove(calendarId: string, extEventId: string): Promise<void>;
  // Upsert the record of one written event (by id when it has one).
  record(row: {
    id?: string;
    trip_id: string;
    kind: "session" | "leg";
    item_key: string;
    ext_event_id: string;
    ext_calendar_id: string;
    content_hash: string;
  }): Promise<void>;
  forget(id: string): Promise<void>;
}

export interface FamilySyncResult {
  created: number;
  updated: number;
  deleted: number;
  // Counts only: a failure never carries event text.
  failed: number;
}

export async function runFamilySync(
  desired: DesiredEvent[],
  recorded: RecordedEvent[],
  io: FamilyIO,
  calendarId: string
): Promise<FamilySyncResult> {
  const plan = planFamilySync(desired, recorded, calendarId);
  const res: FamilySyncResult = { created: 0, updated: 0, deleted: 0, failed: 0 };

  for (const r of plan.remove) {
    try {
      await io.remove(r.ext_calendar_id, r.ext_event_id);
      await io.forget(r.id);
      res.deleted += 1;
    } catch {
      res.failed += 1; // the record stays, so the next run tries again
    }
  }
  for (const d of plan.create) {
    try {
      const ext = await io.create(d.payload);
      await io.record({ trip_id: d.trip_id, kind: d.kind, item_key: d.item_key, ext_event_id: ext, ext_calendar_id: calendarId, content_hash: d.hash });
      res.created += 1;
    } catch {
      res.failed += 1;
    }
  }
  for (const { desired: d, recorded: r } of plan.update) {
    try {
      let ext = r.ext_event_id;
      if (r.ext_calendar_id !== calendarId) {
        await io.remove(r.ext_calendar_id, r.ext_event_id);
        ext = await io.create(d.payload);
      } else if (!(await io.patch(r.ext_calendar_id, r.ext_event_id, d.payload))) {
        ext = await io.create(d.payload);
      }
      await io.record({ id: r.id, trip_id: d.trip_id, kind: d.kind, item_key: d.item_key, ext_event_id: ext, ext_calendar_id: calendarId, content_hash: d.hash });
      res.updated += 1;
    } catch {
      res.failed += 1;
    }
  }
  return res;
}
