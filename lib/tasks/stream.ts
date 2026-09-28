// B20. Which work stream a name from the assistant means.
//
// create_task used to file an unknown stream name under Personal without a
// word, which is how professional mail ended up in Personal. An unknown name
// is now refused with the real list, so the model can pick again. No name at
// all still means Personal. Pure and import-free for scripts/b20.test.ts.

export interface StreamRow {
  id: string;
  name: string;
}

export type StreamPick = { ok: true; id: string } | { ok: false; message: string };

export function pickWorkStream(streams: StreamRow[], name: string | null): StreamPick {
  if (!streams.length) return { ok: false, message: "No work streams exist." };
  const wanted = (name ?? "").trim().toLowerCase();
  const byName = (n: string) => streams.find((w) => w.name.trim().toLowerCase() === n);
  if (!wanted) {
    return { ok: true, id: (byName("personal") ?? streams[0]).id };
  }
  const hit = byName(wanted);
  if (hit) return { ok: true, id: hit.id };
  const names = streams.map((w) => w.name).sort((a, b) => a.localeCompare(b));
  return {
    ok: false,
    message: `There is no work stream called "${name!.trim()}". Use one of: ${names.join(", ")}.`,
  };
}

// B22. One work stream's rate and mail scan hint, checked the same way for
// Settings (setWorkStreamRateAction) and for update_work_stream. undefined
// means unchanged. A hint is one line of plain text, at most 200 characters
// (the column's own check); an empty hint clears it. A rate is rupees an hour,
// zero or more; null clears it, which only Settings can ask for.
export const SCAN_HINT_MAX = 200;

export type StreamEdit =
  | { ok: true; patch: { hourly_rate?: number | null; scan_hint?: string | null } }
  | { ok: false; message: string };

export function checkStreamEdit(
  rate: number | null | undefined,
  scanHint: string | null | undefined
): StreamEdit {
  if (rate !== undefined && rate !== null && (!Number.isFinite(rate) || rate < 0)) {
    return { ok: false, message: "A rate must be a number." };
  }
  const hint =
    scanHint === undefined ? undefined : (scanHint ?? "").replace(/\s+/g, " ").trim() || null;
  if (hint && hint.length > SCAN_HINT_MAX) {
    return { ok: false, message: `Keep the mail scan hint to ${SCAN_HINT_MAX} characters.` };
  }
  return {
    ok: true,
    patch: {
      ...(rate !== undefined ? { hourly_rate: rate } : {}),
      ...(hint !== undefined ? { scan_hint: hint } : {}),
    },
  };
}
