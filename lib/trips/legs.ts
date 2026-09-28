// B22. Correcting or removing one journey on a trip. Legs live in the trip's
// jsonb column, so an edit is a read, a change and a write of the whole array.
//
// The index is the leg's position in the list lifeos_list_trips returns,
// which is parseLegs order (sorted by date), so the model and this module
// count the same legs. The undo keeps the RAW column value from before the
// edit, not a re-parsed copy, so undo writes back exactly what was there.
// Pure, relative imports only, for scripts/b22.test.ts.

import { TRANSPORT_MODES, parseLegs, type TransportMode, type TripLeg } from "./core.ts";

export type LegEdit =
  | { ok: true; legs: TripLeg[]; leg: TripLeg | null }
  | { ok: false; message: string };

function text(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

function pickLeg(raw: unknown, index: unknown): { legs: TripLeg[]; i: number } | string {
  const legs = parseLegs(raw);
  const i = typeof index === "number" ? index : Number.NaN;
  if (!Number.isInteger(i) || i < 0 || i >= legs.length) {
    return legs.length
      ? `leg_index must be 0 to ${legs.length - 1}: the trip has ${legs.length} ${legs.length === 1 ? "leg" : "legs"}.`
      : "The trip has no legs logged.";
  }
  return { legs, i };
}

export function editLeg(raw: unknown, index: unknown, input: Record<string, unknown>): LegEdit {
  const picked = pickLeg(raw, index);
  if (typeof picked === "string") return { ok: false, message: picked };
  const { legs, i } = picked;
  const date = text(input.date);
  if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return { ok: false, message: "date must be YYYY-MM-DD." };
  }
  const mode = text(input.mode);
  if (mode && !TRANSPORT_MODES.includes(mode as TransportMode)) {
    return { ok: false, message: `mode must be one of ${TRANSPORT_MODES.join(", ")}.` };
  }
  const ref = text(input.ref);
  const leg: TripLeg = {
    ...legs[i],
    ...(text(input.from_city) ? { from: text(input.from_city)! } : {}),
    ...(text(input.to_city) ? { to: text(input.to_city)! } : {}),
    ...(date ? { date } : {}),
    ...(mode ? { mode: mode as TransportMode } : {}),
    ...(ref ? { ref: ref.slice(0, 40) } : {}),
  };
  const next = legs.slice();
  next[i] = leg;
  return { ok: true, legs: parseLegs(next), leg };
}

export function removeLeg(raw: unknown, index: unknown): LegEdit {
  const picked = pickLeg(raw, index);
  if (typeof picked === "string") return { ok: false, message: picked };
  const { legs, i } = picked;
  return { ok: true, legs: legs.filter((_, k) => k !== i), leg: legs[i] };
}
