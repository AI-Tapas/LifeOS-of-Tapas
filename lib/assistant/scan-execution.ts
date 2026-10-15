import type { Actor } from "@/lib/assistant/actor";

export class ScanExecutionError extends Error {
  code: "scan_busy" | "scan_uncertain" | "storage_unavailable";
  constructor(code: ScanExecutionError["code"], message: string) {
    super(message);
    this.name = "ScanExecutionError";
    this.code = code;
  }
}

// A durable owner-wide claim, shared by every scan entrypoint. An abandoned
// claim is taken over only after 2 hours (SQL); duplicates are caught by the near-duplicate guard.
export async function withScanExecution<T>(actor: Actor, work: () => Promise<T>): Promise<T> {
  const { data, error } = await actor.supabase.rpc("claim_scan_execution", { p_user_id: actor.userId });
  const claim = data as { claimed?: boolean; status?: string; run_id?: string } | null;
  if (error || !claim || typeof claim.run_id !== "string" || typeof claim.claimed !== "boolean") {
    throw new ScanExecutionError("storage_unavailable", "Could not claim the mail scan. No scan was started.");
  }
  if (!claim.claimed) {
    if (claim.status === "uncertain") throw new ScanExecutionError("scan_uncertain", "An earlier mail scan has an uncertain outcome. Review it before starting another scan.");
    throw new ScanExecutionError("scan_busy", "A mail scan is already running. No second scan was started.");
  }
  let result: T;
  try {
    result = await work();
  } catch (error) {
    await releaseClaim(actor, claim.run_id);
    throw error;
  }
  // The scan succeeded: a failed release is logged, never thrown over its result.
  // A stuck claim is taken over automatically after 2 hours.
  await releaseClaim(actor, claim.run_id);
  return result;
}

async function releaseClaim(actor: Actor, runId: string): Promise<void> {
  try {
    const { data, error } = await actor.supabase.rpc("release_scan_execution", { p_user_id: actor.userId, p_run_id: runId });
    if (error || data !== true) console.error("scan execution claim could not be released", error?.message ?? "not released");
  } catch (e) {
    console.error("scan execution claim release failed", e instanceof Error ? e.message : e);
  }
}
