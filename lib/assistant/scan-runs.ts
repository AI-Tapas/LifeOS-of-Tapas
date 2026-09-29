// B22. What each 3 AM mail scan did, for lifeos_list_scan_runs, read back
// from the audit rows the scan and the brief already write: cron_scan (the
// job), mail_scan (one per account, counts only since B20) and tasks_lapsed
// (the morning sweep of closed windows). COUNTS AND IDS ONLY: the cron_scan
// row's notes can quote a task title, so they are never handed on, and no
// row here carries mail text in the first place. Pure, for scripts/b22.test.ts.

export interface AuditRow {
  id: string;
  action: string;
  ts: string;
  entity_id?: string | null;
  meta: unknown;
}

export interface ScanRun {
  date: string; // IST calendar date
  ran: boolean;
  failed: boolean;
  // B24: a cron_scan_started row with no finish row (cut off, e.g. a timeout).
  started_never_finished: boolean;
  audit_id: string | null;
  emails_read: number;
  tasks_created: number;
  dropped_as_duplicates: number;
  dropped_as_signatures: number;
  windows_lapsed: number;
  lapsed_task_ids: string[];
  ticket_legs_logged: number;
  tickets_without_trip: number;
  cab_receipts_added: number;
  accounts: { account_id: string | null; slot: string | null; emails_read: number }[];
}

export const SCAN_RUN_ACTIONS = ["cron_scan_started", "cron_scan", "cron_scan_failed", "mail_scan", "tasks_lapsed"];

export function clampScanDays(v: unknown): number {
  const n = Number(v);
  if (v === undefined || v === null || !Number.isFinite(n)) return 1;
  return Math.min(Math.max(Math.trunc(n), 1), 14);
}

function istDay(iso: string): string {
  return new Date(Date.parse(iso) + 330 * 60000).toISOString().slice(0, 10);
}

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const len = (v: unknown): number => (Array.isArray(v) ? v.length : 0);

export function scanRuns(rows: AuditRow[]): ScanRun[] {
  const byDay = new Map<string, ScanRun>();
  const day = (date: string): ScanRun => {
    let r = byDay.get(date);
    if (!r) {
      r = {
        date,
        ran: false,
        failed: false,
        started_never_finished: false,
        audit_id: null,
        emails_read: 0,
        tasks_created: 0,
        dropped_as_duplicates: 0,
        dropped_as_signatures: 0,
        windows_lapsed: 0,
        lapsed_task_ids: [],
        ticket_legs_logged: 0,
        tickets_without_trip: 0,
        cab_receipts_added: 0,
        accounts: [],
      };
      byDay.set(date, r);
    }
    return r;
  };
  for (const row of rows) {
    const meta = (row.meta && typeof row.meta === "object" ? row.meta : {}) as Record<string, unknown>;
    const date = typeof meta.ist_date === "string" ? meta.ist_date : istDay(row.ts);
    if (row.action === "cron_scan_started") {
      // Provisional: cleared below once any finish row for the day exists.
      day(date).started_never_finished = true;
    } else if (row.action === "cron_scan") {
      const r = day(date);
      r.ran = true;
      r.audit_id = row.id;
      r.tasks_created = num(meta.created);
    } else if (row.action === "cron_scan_failed") {
      const r = day(date);
      r.failed = true;
      r.audit_id = r.audit_id ?? row.id;
    } else if (row.action === "mail_scan") {
      // Only the accounts the 03:00 job read, never a scan he ran by hand.
      const prov = (meta.provenance ?? {}) as Record<string, unknown>;
      if (prov.originating_job !== "cron_scan") continue;
      const r = day(date);
      r.emails_read += num(meta.scanned);
      r.dropped_as_duplicates += num(meta.dropped_by_thread) + num(meta.dropped_by_resend);
      r.dropped_as_signatures += len(meta.never_extract);
      r.ticket_legs_logged += num(meta.trip_legs_logged);
      r.tickets_without_trip += num(meta.tickets_without_trip);
      r.cab_receipts_added += num(meta.cab_rides_added);
      r.accounts.push({
        account_id: row.entity_id ?? null,
        slot: typeof meta.slot === "string" ? meta.slot : null,
        emails_read: num(meta.scanned),
      });
    } else if (row.action === "tasks_lapsed") {
      const r = day(date);
      const ids = Array.isArray(meta.dropped) ? meta.dropped.filter((x): x is string => typeof x === "string") : [];
      r.windows_lapsed += ids.length;
      r.lapsed_task_ids.push(...ids);
    }
  }
  for (const r of byDay.values()) if (r.ran || r.failed) r.started_never_finished = false;
  return [...byDay.values()].sort((a, b) => b.date.localeCompare(a.date));
}
