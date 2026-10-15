import { serviceActor } from "@/lib/assistant/actor";
import { runWriteTool } from "@/lib/assistant/mcp-api";
import { createServiceClient } from "@/lib/supabase/service";
import { capabilityAllows, normalizeCapabilities, type McpContext } from "./permissions";
import { failure, operationStore } from "./operations";
// Durable claim precedes work. No detached promise, no retry of timed-out work:
// the platform calls this from Next after() and the protected cron safety net.
export async function runNextMcpJob(): Promise<Record<string, unknown>> {
  const actor = await serviceActor();
  const worker = { userId: actor.userId, clientId: "worker" };
  const job = await operationStore(worker, "claim_job");
  if (!job.id) return { state: "idle" };
  const context: McpContext = { userId: actor.userId, clientId: String(job.client_id), capabilities: normalizeCapabilities(job.capabilities)! };
  let workStarted = false;
  try {
    if (context.clientId !== "shared-secret") {
      const { data, error } = await createServiceClient().from("mcp_clients").select("capabilities,approved_at,revoked_at").eq("client_id", context.clientId).eq("user_id", context.userId).maybeSingle();
      if (error || !data?.approved_at || data.revoked_at) throw new Error("Connection revoked.");
      context.capabilities = normalizeCapabilities(data.capabilities)!;
    }
    if (!context.capabilities || !capabilityAllows(context.capabilities, "lifeos_scan_mail", true, job.input as Record<string, unknown>)) throw new Error("Scan capability revoked.");
    const current = await operationStore(context, "job", { id: job.id });
    if (current.cancel_requested) return operationStore(context, "finish_job", { id: job.id, state: "cancelled", result: { effects_started: false } });
    workStarted = true;
    const result = await runWriteTool("scan_mail", job.input as Record<string, unknown>);
    return operationStore(context, "finish_job", { id: job.id, state: "completed", result: { ...result, cancellation: "Cancellation after work starts cannot undo effects. Review resulting tasks and proposals." } });
  } catch (error) {
    return operationStore(context, "finish_job", { id: job.id, state: workStarted ? "uncertain" : "failed", result: { ...failure(error), state: workStarted ? "uncertain" : "failed", retryable: false } });
  }
}
