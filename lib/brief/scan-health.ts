// B24. The one line at the top of the 7 AM brief when last night's mail scan
// did not do its job. Pure: it reads audit rows already loaded (action, ts,
// meta) and returns a plain sentence or null. The rows carry an IST date and a
// short reason code, never mail text, so neither does the sentence.
//
// The 3 AM scan writes cron_scan_started first, then cron_scan on success or
// cron_scan_failed on an error. A Vercel timeout writes nothing after the
// start row, which is how "cut off" differs from "never ran".

export interface ScanHealthRow {
  action: string;
  ts: string;
  meta: unknown;
}

export const SCAN_HEALTH_ACTIONS = ["cron_scan_started", "cron_scan", "cron_scan_failed"];

export const SCAN_DID_NOT_RUN = "Mail scan did not run last night";
export const SCAN_CUT_OFF = "Mail scan was cut off before finishing";
export const SCAN_FAILED_KEY = "Mail scan failed last night: the AI key was refused. Check the key in Vercel.";
export const SCAN_FAILED_PROVIDER = "Mail scan failed last night: the AI service returned an error. Check the AI provider settings in Vercel.";
export const SCAN_FAILED_OTHER = "Mail scan failed last night.";

export function scanHealthWarning(rows: ScanHealthRow[], istDate: string): string | null {
  const today = rows.filter((r) => {
    const meta = (r.meta && typeof r.meta === "object" ? r.meta : {}) as { ist_date?: unknown };
    return meta.ist_date === istDate;
  });
  const latest = (actions: string[]): ScanHealthRow | null =>
    today
      .filter((r) => actions.includes(r.action))
      .sort((a, b) => Date.parse(b.ts) - Date.parse(a.ts))[0] ?? null;

  const finish = latest(["cron_scan", "cron_scan_failed"]);
  const started = latest(["cron_scan_started"]);
  if (!finish) return started ? `${SCAN_CUT_OFF}.` : `${SCAN_DID_NOT_RUN}.`;
  // A start after the last finish is a re-run that never ended.
  if (started && Date.parse(started.ts) > Date.parse(finish.ts)) return `${SCAN_CUT_OFF}.`;
  if (finish.action === "cron_scan") return null;
  const code = ((finish.meta ?? {}) as { reason_code?: unknown }).reason_code;
  if (code === "auth") return SCAN_FAILED_KEY;
  if (code === "provider") return SCAN_FAILED_PROVIDER;
  return SCAN_FAILED_OTHER;
}
