// B32. Hours on a task: the one parser. Accepts "1.5", "1:30", "0:15" or a
// number, and refuses anything negative, non-numeric or above 500 (the
// database check says the same). Hours only: nothing here knows a rate.
// Pure (no imports), so scripts/b32.test.ts loads it directly.

export const HOURS_MAX = 500;

export type HoursParse =
  | { ok: true; value: number | null } // null: blank, meaning not logged
  | { ok: false; message: string };

function finish(n: number): HoursParse {
  if (!Number.isFinite(n) || n < 0) return { ok: false, message: "Hours must be zero or more." };
  if (n > HOURS_MAX) return { ok: false, message: `Hours cannot be more than ${HOURS_MAX}.` };
  return { ok: true, value: Math.round(n * 100) / 100 };
}

export function parseHours(input: string | number | null | undefined): HoursParse {
  if (input === null || input === undefined) return { ok: true, value: null };
  if (typeof input === "number") return finish(input);
  const t = input.trim();
  if (t === "") return { ok: true, value: null };
  const clock = /^(\d{1,3}):([0-5]\d)$/.exec(t);
  if (clock) return finish(Number(clock[1]) + Number(clock[2]) / 60);
  if (/^\d+(\.\d+)?$/.test(t) || /^\.\d+$/.test(t)) return finish(Number(t));
  if (/^-\d/.test(t)) return { ok: false, message: "Hours must be zero or more." };
  return { ok: false, message: 'Enter hours as 1.5 or 1:30.' };
}

// "32.5", "38", "0.25": trailing zeros dropped.
export function formatHours(n: number): string {
  return String(Math.round(n * 100) / 100);
}
