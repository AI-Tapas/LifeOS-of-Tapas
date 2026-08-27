// Shared guards for the two Vercel Cron routes (scan, brief). Pure: no
// Supabase, no fetch, so both are exercised offline in scripts/m5.test.ts.

import { timingSafeEqual } from "node:crypto";

// Same shape as the LIFEOS_MCP_TOKEN check in app/api/mcp/route.ts: constant
// time compare, and a short/missing secret always refuses rather than
// comparing against an empty string.
export function cronAuthorized(header: string | null): boolean {
  const expected = process.env.CRON_SECRET;
  if (!expected || expected.length < 24) return false;
  const given = (header ?? "").replace(/^Bearer\s+/i, "");
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

// Vercel can redeliver a cron tick, so each route stamps an audit_log row
// with meta.ist_date on success and checks for one before doing real work.
// A failed prior attempt does not stamp this, so a retry after a failure is
// still allowed to run.
export function alreadyRanToday(
  auditRows: Array<{ meta: unknown }>,
  istDate: string
): boolean {
  return auditRows.some((r) => {
    const meta = r.meta as { ist_date?: string } | null;
    return meta?.ist_date === istDate;
  });
}
