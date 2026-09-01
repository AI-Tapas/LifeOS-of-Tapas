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
import { cronAuthorized, alreadyRanToday } from "@/lib/cron/guard";
import { civilKey, civilToday } from "@/lib/datetime";
import type { Json } from "@/lib/database.types";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function GET(req: Request): Promise<Response> {
  if (!cronAuthorized(req.headers.get("authorization"))) {
    return Response.json({ error: "Unauthorized." }, { status: 401 });
  }

  const actor = await serviceActor("cron_scan");
  const istDate = civilKey(civilToday());

  const { data: recent } = await actor.supabase
    .from("audit_log")
    .select("meta")
    .eq("user_id", actor.userId)
    .eq("action", "cron_scan")
    .gte("ts", new Date(Date.now() - 36 * 3600 * 1000).toISOString());
  if (alreadyRanToday(recent ?? [], istDate)) {
    return Response.json({ skipped: true, reason: "already ran today" });
  }

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
    const message = e instanceof Error ? e.message : "mail scan failed";
    await actor.supabase.from("audit_log").insert({
      user_id: actor.userId,
      actor: "assistant",
      action: "cron_scan_failed",
      entity: "cron",
      meta: { ist_date: istDate, message } as Json,
    });
    return Response.json({ ok: false, error: message }, { status: 500 });
  }
}
