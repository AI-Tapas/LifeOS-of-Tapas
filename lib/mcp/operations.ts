import { createHash } from "node:crypto";
import { createServiceClient } from "@/lib/supabase/service";
import type { Json } from "@/lib/database.types";
import type { McpContext } from "./permissions";
export class McpError extends Error {
  constructor(public code: string, message: string, public retryable = false) { super(message); }
}
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`).join(",")}}`;
  return JSON.stringify(value) ?? "null";
}
export function requestHash(tool: string, input: Record<string, unknown>): string { return createHash("sha256").update(canonical({ tool, input })).digest("hex"); }
export async function operationStore(context: Pick<McpContext, "userId" | "clientId">, action: string, args: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  const { data, error } = await createServiceClient().rpc("mcp_service", { p_action: action, p_owner: context.userId, p_client: context.clientId, p_args: args as Json });
  if (error) throw new McpError("storage_unavailable", "The connector could not durably record this operation. Check its status before retrying.", true);
  const result = (data ?? {}) as Record<string, unknown>;
  if (result.error) throw new McpError(String(result.error), `The connector refused the operation: ${result.error}.`, result.error === "rate_limited");
  return result;
}
export function failure(error: unknown): Record<string, unknown> {
  const known = error instanceof McpError;
  return { state: "failed", error: { code: known ? error.code : "operation_failed", message: known ? error.message : "The operation failed. Review Life OS activity and retry only after checking its outcome.", retryable: known ? error.retryable : false } };
}
