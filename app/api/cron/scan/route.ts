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
import { ScanExecutionError } from "@/lib/assistant/scan-execution";
import { cronAuthorized } from "@/lib/cron/guard";
import { civilKey, civilToday } from "@/lib/datetime";
import { claimCronRun, finishCronRun, skippedCronRun } from "@/lib/cron/runs";

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

  let claim;
  try {
    claim = await claimCronRun(actor, "scan", istDate);
  } catch {
    return Response.json({ ok: false, error: "Could not claim scan. No work was started.", retryable: true }, { status: 503 });
  }
  if (!claim.claimed) return skippedCronRun(claim);

  let summary;
  try {
    summary = await runMailScan(actor);
  } catch (e) {
    const failure = e instanceof ScanModelError ? e : null;
    const message = (failure?.message ?? (e instanceof Error ? e.message : "mail scan failed")).slice(0, 200);
    const execution = e instanceof ScanExecutionError ? e : null;
    const state = execution?.code === "scan_uncertain" ? "uncertain" : "failed";
    try {
      await finishCronRun(actor, "scan", istDate, claim.run_id, state, {
        message, reason_code: failure?.code ?? execution?.code ?? "other",
      });
    } catch {
      return Response.json({ ok: false, run_id: claim.run_id, state: "uncertain",
        error: "Scan failed and its result could not be saved. Inspect the run before retrying.", retryable: false }, { status: 503 });
    }
    return Response.json({ ok: false, run_id: claim.run_id, state, error: message, retryable: state === "failed" }, { status: 500 });
  }
  try {
    await finishCronRun(actor, "scan", istDate, claim.run_id, "succeeded", { ...summary });
  } catch {
    return Response.json({ ok: false, run_id: claim.run_id, state: "uncertain",
      error: "Scan completed but its result could not be saved. Inspect the run before retrying.", retryable: false }, { status: 503 });
  }
  return Response.json({ ok: true, run_id: claim.run_id, state: "succeeded", ...summary });
}
