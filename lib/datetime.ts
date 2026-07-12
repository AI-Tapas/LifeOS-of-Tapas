// Date, time and money helpers. Timestamps are stored UTC and displayed IST.
// India runs a fixed +05:30 offset with no daylight saving, so day-bucketing
// and grid maths use a fixed offset; display strings use Intl with the IST
// zone. Pure and dependency-free so client and server share one implementation.

export const IST_TZ = "Asia/Kolkata";
const IST_OFFSET_MS = 330 * 60 * 1000; // +05:30, no DST

// A calendar date with no time component. month is 1-12.
export interface CivilDate {
  y: number;
  m: number;
  d: number;
}

function asDate(iso: string | Date): Date {
  return typeof iso === "string" ? new Date(iso) : iso;
}

// The IST calendar date for an instant.
export function istCivil(iso: string | Date): CivilDate {
  const shifted = new Date(asDate(iso).getTime() + IST_OFFSET_MS);
  return {
    y: shifted.getUTCFullYear(),
    m: shifted.getUTCMonth() + 1,
    d: shifted.getUTCDate(),
  };
}

// "2026-07-17" for the IST calendar date of an instant. Used to bucket events
// into days.
export function istDayKey(iso: string | Date): string {
  return civilKey(istCivil(iso));
}

export function civilKey(c: CivilDate): string {
  const mm = String(c.m).padStart(2, "0");
  const dd = String(c.d).padStart(2, "0");
  return `${c.y}-${mm}-${dd}`;
}

export function civilToday(nowMs: number = Date.now()): CivilDate {
  return istCivil(new Date(nowMs));
}

// Add n days to a civil date, normalising month/year rollover.
export function addDays(c: CivilDate, n: number): CivilDate {
  const base = Date.UTC(c.y, c.m - 1, c.d) + n * 86400000;
  const d = new Date(base);
  return { y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, d: d.getUTCDate() };
}

export function addMonths(c: CivilDate, n: number): CivilDate {
  const total = (c.y * 12 + (c.m - 1)) + n;
  const y = Math.floor(total / 12);
  const m = (total % 12) + 1;
  const dim = daysInMonth(y, m);
  return { y, m, d: Math.min(c.d, dim) };
}

export function daysInMonth(y: number, m: number): number {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

// 0=Sunday .. 6=Saturday for a civil date.
export function civilWeekday(c: CivilDate): number {
  return new Date(Date.UTC(c.y, c.m - 1, c.d)).getUTCDay();
}

// Monday-start week by default (weekStartsOn: 0=Sun, 1=Mon).
export function startOfWeek(c: CivilDate, weekStartsOn = 1): CivilDate {
  const wd = civilWeekday(c);
  const diff = (wd - weekStartsOn + 7) % 7;
  return addDays(c, -diff);
}

export function sameCivil(a: CivilDate, b: CivilDate): boolean {
  return a.y === b.y && a.m === b.m && a.d === b.d;
}

// The instant for an IST wall-clock time on a civil date.
export function istInstant(c: CivilDate, hour = 0, minute = 0): Date {
  return new Date(Date.UTC(c.y, c.m - 1, c.d, hour, minute) - IST_OFFSET_MS);
}

// The IST clock hour (0-23) of an instant.
export function istHour(iso: string | Date): number {
  return new Date(asDate(iso).getTime() + IST_OFFSET_MS).getUTCHours();
}

export function istMinute(iso: string | Date): number {
  return new Date(asDate(iso).getTime() + IST_OFFSET_MS).getUTCMinutes();
}

// ---------------------------------------------------------------------------
// Display formatting
// ---------------------------------------------------------------------------
const DATE_FMT = new Intl.DateTimeFormat("en-GB", {
  timeZone: IST_TZ,
  day: "numeric",
  month: "long",
  year: "numeric",
});
const DATE_SHORT_FMT = new Intl.DateTimeFormat("en-GB", {
  timeZone: IST_TZ,
  day: "numeric",
  month: "short",
});
const TIME_FMT = new Intl.DateTimeFormat("en-GB", {
  timeZone: IST_TZ,
  hour: "numeric",
  minute: "2-digit",
  hour12: true,
});
const WEEKDAY_FMT = new Intl.DateTimeFormat("en-GB", {
  timeZone: IST_TZ,
  weekday: "short",
});

// "17 May 2026"
export function formatDateIST(iso: string | Date): string {
  return DATE_FMT.format(asDate(iso));
}

// "17 May"
export function formatDateShortIST(iso: string | Date): string {
  return DATE_SHORT_FMT.format(asDate(iso));
}

// "9:30 am"
export function formatTimeIST(iso: string | Date): string {
  return TIME_FMT.format(asDate(iso)).toLowerCase();
}

// "17 May 2026, 9:30 am"
export function formatDateTimeIST(iso: string | Date): string {
  return `${formatDateIST(iso)}, ${formatTimeIST(iso)}`;
}

// "Fri"
export function formatWeekdayIST(iso: string | Date): string {
  return WEEKDAY_FMT.format(asDate(iso));
}

// "July 2026"
export function formatMonthYear(c: CivilDate): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: IST_TZ,
    month: "long",
    year: "numeric",
  }).format(istInstant(c, 12, 0));
}

// Indian digit grouping, e.g. 12000000 -> "1,20,00,000". Two decimals only when
// the value is not whole. Prefixed with the rupee sign.
export function formatINR(n: number | null | undefined): string {
  if (n === null || n === undefined) return "";
  const whole = Number.isInteger(n);
  const grouped = new Intl.NumberFormat("en-IN", {
    minimumFractionDigits: whole ? 0 : 2,
    maximumFractionDigits: 2,
  }).format(n);
  return `₹ ${grouped}`;
}
