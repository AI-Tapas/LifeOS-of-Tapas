import type { Actor } from "@/lib/assistant/actor";
import type { Json } from "@/lib/database.types";

export type CronJob = "scan" | "brief";
export type CronStatus = "running" | "succeeded" | "failed" | "uncertain";
export type CronClaim = { claimed: boolean; run_id: string; status: CronStatus };

export async function claimCronRun(actor: Actor, job: CronJob, date: string): Promise<CronClaim> {
  const { data, error } = await actor.supabase.rpc("claim_cron_run", {
    p_user_id: actor.userId, p_job: job, p_ist_date: date,
  });
  if (error) throw new Error("Could not claim cron run. No work was started.");
  const result = data as unknown as CronClaim | null;
  if (!result || typeof result.claimed !== "boolean" || typeof result.run_id !== "string" ||
      !["running", "succeeded", "failed", "uncertain"].includes(result.status)) {
    throw new Error("Invalid cron claim response. No work was started.");
  }
  return result;
}

export async function markCronDispatch(actor: Actor, job: CronJob, date: string, runId: string): Promise<void> {
  const { data, error } = await actor.supabase.rpc("mark_cron_dispatch", {
    p_user_id: actor.userId, p_job: job, p_ist_date: date, p_run_id: runId,
  });
  if (error || data !== true) throw new Error("Could not reserve brief dispatch. No email was sent.");
}

export async function finishCronRun(actor: Actor, job: CronJob, date: string, runId: string,
  status: Exclude<CronStatus, "running">, result: Record<string, Json | undefined> = {}): Promise<void> {
  const { data, error } = await actor.supabase.rpc("finish_cron_run", {
    p_user_id: actor.userId, p_job: job, p_ist_date: date, p_run_id: runId,
    p_status: status, p_result: result,
  });
  if (error || data !== true) throw new Error("Could not persist the cron result. Inspect the run before retrying.");
}

export function skippedCronRun(claim: CronClaim): Response {
  return Response.json({ skipped: true, run_id: claim.run_id, state: claim.status,
    reason: claim.status === "succeeded" ? "already ran today" :
      claim.status === "uncertain" ? "previous outcome uncertain; reconcile before retrying" : "already running",
    retryable: false,
  });
}
