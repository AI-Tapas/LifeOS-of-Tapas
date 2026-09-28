// B22. The composed 7 AM brief, kept so the AI workforce can read what Tapas
// was told this morning (lifeos_get_last_brief). One row per IST day in the
// briefs table (migration 20260928000100), the last 30 days only: every save
// trims what is older.
//
// A table rather than an audit row: audit_log is append-only, so it could
// not keep 30 days, and the brief carries task titles, some from scanned
// mail, which do not belong in the audit trail. Pure and dependency-injected
// (the store is passed in), for scripts/b22.test.ts.

export const BRIEF_KEEP_DAYS = 30;

export interface BriefRow {
  brief_date: string; // IST calendar date, YYYY-MM-DD
  subject: string;
  body_text: string;
}

export interface BriefStore {
  upsert(row: BriefRow): Promise<void>;
  deleteBefore(date: string): Promise<void>;
  // The newest row on or before the date, or the newest of all.
  latest(onOrBefore: string | null): Promise<(BriefRow & { created_at?: string }) | null>;
}

function shiftKey(key: string, days: number): string {
  const [y, m, d] = key.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

export function briefCutoff(istDate: string): string {
  return shiftKey(istDate, -(BRIEF_KEEP_DAYS - 1));
}

export async function keepBrief(store: BriefStore, row: BriefRow): Promise<void> {
  await store.upsert(row);
  await store.deleteBefore(briefCutoff(row.brief_date));
}

export async function lastBrief(
  store: BriefStore,
  date: unknown
): Promise<(BriefRow & { created_at?: string }) | null> {
  const raw = typeof date === "string" ? date.trim() : "";
  if (raw && !/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    throw new Error("date must be YYYY-MM-DD (IST).");
  }
  return store.latest(raw || null);
}
