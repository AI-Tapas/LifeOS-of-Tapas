// Pure event logic: the attendee-confirmation gate, provider write payloads
// (Google and Microsoft Graph) and provider-event parsers used by the sync read
// path. Zero imports so scripts/m3.test.ts can load it under `node --test`.
// The DB- and network-wired create/edit is lib/events/write.ts.

export const IST_TZ = "Asia/Kolkata";
const IST_OFFSET_MIN = 330;

// ---------------------------------------------------------------------------
// Attendee-confirmation gate (the firm confirmation rule for M3)
// ---------------------------------------------------------------------------
// Thrown by the write path when an event carries attendees but the caller has
// not confirmed the invite. Enforced in code, not only in the UI: M4's
// assistant reuses this same gate.
export class ConfirmationRequiredError extends Error {
  attendeeCount: number;
  constructor(attendeeCount: number) {
    super(
      `This will send an invite to ${attendeeCount} ${
        attendeeCount === 1 ? "person" : "people"
      }. Confirm to continue.`
    );
    this.name = "ConfirmationRequiredError";
    this.attendeeCount = attendeeCount;
  }
}

export interface EventAttendee {
  email: string;
  name?: string;
}

export interface AppEventInput {
  title: string;
  description?: string;
  location?: string;
  startIso: string; // UTC instant, or an all-day date-start instant
  endIso?: string;
  allDay?: boolean;
  attendees?: EventAttendee[];
}

// The gate. Any payload with one or more attendees requires confirmed === true.
export function requireConfirmationIfAttendees(
  input: AppEventInput,
  confirmed: boolean
): void {
  const n = input.attendees?.length ?? 0;
  if (n > 0 && !confirmed) throw new ConfirmationRequiredError(n);
}

// ---------------------------------------------------------------------------
// Small date helpers (import-free; IST is a fixed +05:30 offset)
// ---------------------------------------------------------------------------
function istDateOnly(iso: string): string {
  const shifted = new Date(new Date(iso).getTime() + IST_OFFSET_MIN * 60000);
  return shifted.toISOString().slice(0, 10);
}

// Instant for 00:00 IST on a "YYYY-MM-DD" date, as a UTC ISO string.
function istMidnightIso(dateOnly: string): string {
  return new Date(`${dateOnly}T00:00:00+05:30`).toISOString();
}

function addMinutesIso(iso: string, minutes: number): string {
  return new Date(new Date(iso).getTime() + minutes * 60000).toISOString();
}

// Graph wants a local dateTime without a trailing Z, paired with a timeZone.
function stripZ(iso: string): string {
  return iso.replace(/\.\d+Z$/, "").replace(/Z$/, "");
}

// ---------------------------------------------------------------------------
// Write payloads
// ---------------------------------------------------------------------------
export interface GoogleEventBody {
  summary: string;
  description?: string;
  location?: string;
  start: { date?: string; dateTime?: string; timeZone?: string };
  end: { date?: string; dateTime?: string; timeZone?: string };
  attendees?: { email: string; displayName?: string }[];
}

export function buildGoogleEventPayload(input: AppEventInput): GoogleEventBody {
  const body: GoogleEventBody = {
    summary: input.title,
    start: {},
    end: {},
  };
  if (input.description) body.description = input.description;
  if (input.location) body.location = input.location;

  if (input.allDay) {
    const startDate = istDateOnly(input.startIso);
    // Google all-day end.date is exclusive; default to the next day.
    const endDate = input.endIso
      ? istDateOnly(input.endIso)
      : istDateOnly(addMinutesIso(input.startIso, 1440));
    body.start = { date: startDate };
    body.end = { date: endDate };
  } else {
    body.start = { dateTime: input.startIso, timeZone: IST_TZ };
    body.end = {
      dateTime: input.endIso ?? addMinutesIso(input.startIso, 30),
      timeZone: IST_TZ,
    };
  }
  if (input.attendees?.length) {
    body.attendees = input.attendees.map((a) => ({
      email: a.email,
      displayName: a.name,
    }));
  }
  return body;
}

export interface GraphEventBody {
  subject: string;
  body?: { contentType: "text"; content: string };
  location?: { displayName: string };
  isAllDay: boolean;
  start: { dateTime: string; timeZone: string };
  end: { dateTime: string; timeZone: string };
  attendees?: {
    emailAddress: { address: string; name?: string };
    type: "required";
  }[];
}

export function buildGraphEventPayload(input: AppEventInput): GraphEventBody {
  const body: GraphEventBody = {
    subject: input.title,
    isAllDay: !!input.allDay,
    start: { dateTime: "", timeZone: "UTC" },
    end: { dateTime: "", timeZone: "UTC" },
  };
  if (input.description) {
    body.body = { contentType: "text", content: input.description };
  }
  if (input.location) body.location = { displayName: input.location };

  if (input.allDay) {
    const startDate = istDateOnly(input.startIso);
    const endDate = input.endIso
      ? istDateOnly(input.endIso)
      : istDateOnly(addMinutesIso(input.startIso, 1440));
    body.start = { dateTime: `${startDate}T00:00:00`, timeZone: IST_TZ };
    body.end = { dateTime: `${endDate}T00:00:00`, timeZone: IST_TZ };
  } else {
    body.start = { dateTime: stripZ(input.startIso), timeZone: "UTC" };
    body.end = {
      dateTime: stripZ(input.endIso ?? addMinutesIso(input.startIso, 30)),
      timeZone: "UTC",
    };
  }
  if (input.attendees?.length) {
    body.attendees = input.attendees.map((a) => ({
      emailAddress: { address: a.email, name: a.name },
      type: "required",
    }));
  }
  return body;
}

// Prepare a provider write payload after enforcing the confirmation gate. This
// is the pure heart of the write path: lib/events/write.ts calls it first, then
// performs the network + DB work.
export function prepareEventWrite(
  provider: "google" | "microsoft",
  input: AppEventInput,
  confirmed: boolean
): GoogleEventBody | GraphEventBody {
  requireConfirmationIfAttendees(input, confirmed);
  return provider === "google"
    ? buildGoogleEventPayload(input)
    : buildGraphEventPayload(input);
}

// ---------------------------------------------------------------------------
// Read parsers (provider event -> events row, or a delete instruction)
// ---------------------------------------------------------------------------
export interface ParsedUpsert {
  kind: "upsert";
  ext_event_id: string;
  title: string;
  description: string | null;
  location: string | null;
  start_ts: string;
  end_ts: string | null;
  all_day: boolean;
  attendees: unknown;
}
export interface ParsedDelete {
  kind: "delete";
  ext_event_id: string;
}
export type ParsedEvent = ParsedUpsert | ParsedDelete;

interface GoogleApiEvent {
  id: string;
  status?: string;
  summary?: string;
  description?: string;
  location?: string;
  start?: { date?: string; dateTime?: string };
  end?: { date?: string; dateTime?: string };
  attendees?: { email?: string; displayName?: string; responseStatus?: string }[];
}

export function parseGoogleEvent(item: GoogleApiEvent): ParsedEvent | null {
  if (!item.id) return null;
  if (item.status === "cancelled") {
    return { kind: "delete", ext_event_id: item.id };
  }
  const allDay = !!item.start?.date;
  let start_ts: string;
  let end_ts: string | null;
  if (allDay) {
    start_ts = istMidnightIso(item.start!.date!);
    end_ts = item.end?.date ? istMidnightIso(item.end.date) : null;
  } else {
    if (!item.start?.dateTime) return null;
    start_ts = new Date(item.start.dateTime).toISOString();
    end_ts = item.end?.dateTime ? new Date(item.end.dateTime).toISOString() : null;
  }
  const attendees =
    item.attendees?.map((a) => ({
      email: a.email ?? null,
      name: a.displayName ?? null,
      response: a.responseStatus ?? null,
    })) ?? null;
  return {
    kind: "upsert",
    ext_event_id: item.id,
    title: item.summary ?? "(no title)",
    description: item.description ?? null,
    location: item.location ?? null,
    start_ts,
    end_ts,
    all_day: allDay,
    attendees,
  };
}

interface GraphApiEvent {
  id: string;
  "@removed"?: unknown;
  subject?: string;
  bodyPreview?: string;
  isAllDay?: boolean;
  location?: { displayName?: string };
  start?: { dateTime?: string; timeZone?: string };
  end?: { dateTime?: string; timeZone?: string };
  attendees?: {
    emailAddress?: { address?: string; name?: string };
    status?: { response?: string };
  }[];
}

// Graph delta returns removed items as { id, "@removed": {...} }. Timed events
// arrive in UTC (we send Prefer: outlook.timezone="UTC"); all-day events are
// bucketed by their IST date, matching the Google path.
export function parseGraphEvent(item: GraphApiEvent): ParsedEvent | null {
  if (!item.id) return null;
  if (item["@removed"]) return { kind: "delete", ext_event_id: item.id };

  const allDay = !!item.isAllDay;
  const toUtc = (dt?: string): string | null => {
    if (!dt) return null;
    const hasZone = /[Zz]|[+-]\d{2}:?\d{2}$/.test(dt);
    return new Date(hasZone ? dt : `${dt}Z`).toISOString();
  };
  let start_ts: string | null;
  let end_ts: string | null;
  if (allDay) {
    const sd = item.start?.dateTime?.slice(0, 10);
    const ed = item.end?.dateTime?.slice(0, 10);
    start_ts = sd ? istMidnightIso(sd) : null;
    end_ts = ed ? istMidnightIso(ed) : null;
  } else {
    start_ts = toUtc(item.start?.dateTime);
    end_ts = toUtc(item.end?.dateTime);
  }
  if (!start_ts) return null;
  const attendees =
    item.attendees?.map((a) => ({
      email: a.emailAddress?.address ?? null,
      name: a.emailAddress?.name ?? null,
      response: a.status?.response ?? null,
    })) ?? null;
  return {
    kind: "upsert",
    ext_event_id: item.id,
    title: item.subject ?? "(no title)",
    description: item.bodyPreview ?? null,
    location: item.location?.displayName ?? null,
    start_ts,
    end_ts,
    all_day: allDay,
    attendees,
  };
}
