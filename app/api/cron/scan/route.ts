// Night mail-scan cron. Runs at 03:00 IST (21:30 UTC the previous day - see
// vercel.json). Vercel calls this with GET and Authorization: Bearer
// $CRON_SECRET; no cookie session exists on this path, so the owner is
// resolved by serviceActor() rather than trusted from the request, exactly
// like the MCP connector. runMailScan already loops every connected account
// and catches per-account failures internally, so one dead account cannot
// stop the others; this wrapper only guards auth, idempotency and the
// job-level failure case runMailScan itself cannot catch (e.g. it never
// reaching the account loop at all).

import { serviceActor } from "@/lib/assistant/actor";
import { runMailScan } from "@/lib/assistant/scan";
import { ScanModelError } from "@/lib/assistant/scan-args";
import { cronAuthorized, alreadyRanToday } from "@/lib/cron/guard";
import { civilKey, civilToday } from "@/lib/datetime";
import type { Json } from "@/lib/database.types";

export const runtime = "nodejs";
// B24: was 60. Since B20 and B21 one night is up to nine model turns plus PDF
// downloads, and a Vercel timeout writes no audit row at all. 300 seconds is
// the ceiling of every plan that already accepts this project's 120 second
// chat route (Hobby with Fluid Compute, and Pro's default cap).
export const maxDuration = 300;

export async function GET(req: Request): Promise<Response> {
  if (!cronAuthorized(req.headers.get("authorization"))) {
    return Response.json({ error: "Unauthorized." }, { status: 401 });
  }

  const actor = await serviceActor("cron_scan");
  const istDate = civilKey(civilToday());

  const { data: recent } = await actor.supabase
    .from("audit_log")
    .select("action, ts, meta")
    .eq("user_id", actor.userId)
    .in("action", ["cron_scan", "cron_scan_started"])
    .gte("ts", new Date(Date.now() - 36 * 3600 * 1000).toISOString());
  if (alreadyRanToday(recent ?? [], istDate)) {
    return Response.json({ skipped: true, reason: "already ran today" });
  }

  // B24: stamped before any work, so the 7 AM brief can tell "never ran"
  // from "started and was cut off" (a Vercel timeout writes nothing else).
  // The already-ran check above treats this row as "running" only while it is
  // younger than RUNNING_MINUTES, so a cut-off run or a cron_scan_failed row
  // never blocks a same-day manual re-run after that.
  await actor.supabase.from("audit_log").insert({
    user_id: actor.userId,
    actor: "assistant",
    action: "cron_scan_started",
    entity: "cron",
    meta: { ist_date: istDate } as Json,
  });

  try {
    const summary = await runMailScan(actor);
    await actor.supabase.from("audit_log").insert({
      user_id: actor.userId,
      actor: "assistant",
      action: "cron_scan",
      entity: "cron",
      meta: { ist_date: istDate, ...summary } as Json,
    });
    return Response.json({ ok: true, ...summary });
  } catch (e) {
    // A model failure carries a code and a fixed short phrase (never the
    // provider's body). Anything else keeps its own message, capped.
    const failure = e instanceof ScanModelError ? e : null;
    const message = (failure?.message ?? (e instanceof Error ? e.message : "mail scan failed")).slice(0, 200);
    await actor.supabase.from("audit_log").insert({
      user_id: actor.userId,
      actor: "assistant",
      action: "cron_scan_failed",
      entity: "cron",
      meta: { ist_date: istDate, message, reason_code: failure?.code ?? "other" } as Json,
    });
    return Response.json({ ok: false, error: message }, { status: 500 });
  }
}
