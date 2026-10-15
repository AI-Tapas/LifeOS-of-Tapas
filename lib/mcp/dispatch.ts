import { randomUUID } from "node:crypto";
import { READ_TOOL_NAMES, READ_TOOL_DESCRIPTIONS, READ_TOOL_SCHEMAS, runReadTool, runWriteTool, writeTools } from "@/lib/assistant/mcp-api";
import { serviceActor } from "@/lib/assistant/actor";
import { createServiceClient } from "@/lib/supabase/service";
import { capabilityAllows, type McpContext } from "./permissions";
import { failure, McpError, operationStore, requestHash } from "./operations";
export interface ToolEntry { name: string; description: string; input_schema: Record<string, unknown>; output_schema: Record<string, unknown>; read_only: boolean; queues_for_approval?: boolean }
const objectSchema = (properties: Record<string, unknown>, required: string[] = []) => ({ type: "object", properties, required, additionalProperties: false });
const id = { type: "string", minLength: 1, maxLength: 100 };
export const RESULT_SCHEMA: Record<string, unknown> = { type: "object", properties: { action_id: { type: ["string", "null"] }, undo_available: { type: "boolean" }, retryable: { type: "boolean" }, source: { type: "string" }, fetched_at: { type: "string" }, untrusted_content: { type: "boolean" }, replayed: { type: "boolean" }, message: { type: "string" }, state: { type: "string" }, operation_id: { type: ["string", "null"] }, data: { type: "object" }, error: { type: "object" } }, required: ["state"], additionalProperties: true };
const extras = [
  ["operation_status", "Inspect this connection's durable operation, including a timed-out call. Never retry an uncertain operation blindly.", objectSchema({ operation_id: id }, ["operation_id"]), true],
  ["start_scan_job", "Queue a durable background mail scan. Poll job_status/job_results. Cancellation cannot undo completed effects; scans never send mail.", objectSchema({ account: { type: "string" }, days: { type: "integer", minimum: 1, maximum: 14 } }), false],
  ["job_status", "Get this connection's scan state, timestamps and cancellation flag. Progress is phase-based, not a fabricated percentage.", objectSchema({ job_id: id }, ["job_id"]), true],
  ["job_results", "Get this connection's completed scan results or its current phase.", objectSchema({ job_id: id }, ["job_id"]), true],
  ["job_cancel", "Cancel queued work, or request cancellation before a running worker starts the scan. Once a scan starts, its effects are not reversed.", objectSchema({ job_id: id }, ["job_id"]), false],
  ["preview_patch", "Preview title/text edits to ONE task or note. Returns changes and a 15-minute versioned preview; no mutation. Only tasks title/notes and notes title/body_md are supported.", objectSchema({ table: { type: "string", enum: ["tasks", "notes"] }, record_id: id, patch: { type: "object", properties: { title: { type: "string", minLength: 1, maxLength: 200 }, notes: { type: ["string", "null"], maxLength: 19000 }, body_md: { type: ["string", "null"], maxLength: 19000 } }, additionalProperties: false } }, ["table", "record_id", "patch"]), false],
  ["commit_previews", "Commit up to ten previews. Each record/version/history commits atomically; the batch has explicit per-item results and may partially succeed. No provider effects or approval bypass.", objectSchema({ preview_ids: { type: "array", items: id, minItems: 1, maxItems: 10 } }, ["preview_ids"]), false],
  ["connection_activity", "Recent tool names, states and timestamps for THIS connection only. No tokens, tool arguments or private message bodies are logged.", objectSchema({}), true],
  ["health", "Connection permissions and safe recovery links. For unrestricted connections also account reauthorization and stuck-action counts; no tokens.", objectSchema({}), true],
] as const;
export function manifest(context: McpContext): ToolEntry[] {
  const entries: ToolEntry[] = [
    ...READ_TOOL_NAMES.map(name => ({ name, description: READ_TOOL_DESCRIPTIONS[name], input_schema: READ_TOOL_SCHEMAS[name], output_schema: RESULT_SCHEMA, read_only: true })),
    ...writeTools().map(t => ({ name: `lifeos_${t.name}`, description: t.description, input_schema: t.input_schema, output_schema: RESULT_SCHEMA, read_only: false, queues_for_approval: t.bucket === "confirm" })),
    ...extras.map(([name, description, schema, read_only]) => ({ name: `lifeos_${name}`, description, input_schema: schema as Record<string, unknown>, output_schema: RESULT_SCHEMA, read_only })),
  ];
  return entries.filter(t => capabilityAllows(context.capabilities, t.name, !t.read_only)).map(t => t.read_only ? t : { ...t, input_schema: { ...t.input_schema, properties: { ...(t.input_schema.properties as object), _idempotency_key: { type: "string", minLength: 1, maxLength: 128, description: "Reuse this key only for the identical operation. Retries return its durable original result. Recommended for every write." } } } });
}
export function validateInput(value: unknown, schema: Record<string, unknown>, path = "input"): void {
  const types = Array.isArray(schema.type) ? schema.type : [schema.type];
  const validType = types.some(type => type === undefined || (type === "null" ? value === null : type === "array" ? Array.isArray(value) : type === "object" ? !!value && typeof value === "object" && !Array.isArray(value) : type === "integer" ? Number.isInteger(value) : typeof value === type));
  if (!validType) throw new McpError("invalid_input", `${path} has the wrong type.`);
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) throw new McpError("invalid_input", `${path} is not an allowed value.`);
  if (typeof value === "string" && (value.length > Number(schema.maxLength ?? 50000) || value.length < Number(schema.minLength ?? 0))) throw new McpError("invalid_input", `${path} has an invalid length.`);
  if (typeof value === "number" && (!Number.isFinite(value) || value < Number(schema.minimum ?? -Infinity) || value > Number(schema.maximum ?? Infinity))) throw new McpError("invalid_input", `${path} is outside the allowed range.`);
  if (Array.isArray(value)) {
    if (value.length > Number(schema.maxItems ?? 100) || value.length < Number(schema.minItems ?? 0)) throw new McpError("invalid_input", `${path} has an invalid item count.`);
    if (schema.items) value.forEach((item, i) => validateInput(item, schema.items as Record<string, unknown>, `${path}[${i}]`));
  } else if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>; const properties = (schema.properties ?? {}) as Record<string, Record<string, unknown>>;
    for (const key of (schema.required ?? []) as string[]) if (!Object.prototype.hasOwnProperty.call(obj, key)) throw new McpError("invalid_input", `${path}.${key} is required.`);
    for (const [key, val] of Object.entries(obj)) {
      if (Object.prototype.hasOwnProperty.call(properties, key)) validateInput(val, properties[key], `${path}.${key}`);
      else if (schema.additionalProperties === false) throw new McpError("invalid_input", `${path}.${key} is not supported.`);
    }
  }
}
// Financial fields are removed before serialization on every read result. Free
// text remains app data; a permission cannot infer sensitive meaning in prose.
export function redactFinance(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactFinance);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).filter(([key]) => !/(bill|amount|rate|principal|valuation|hours|cost|expense|value)/i.test(key)).map(([key, item]) => [key, redactFinance(item)]));
}
function pagination(data: Record<string, unknown>): Record<string, unknown> {
  if (!Array.isArray(data.items)) return data;
  return { ...data, pagination: { count: data.items.length, total: data.total ?? null, limit: data.limit ?? data.items.length, offset: data.offset ?? 0, next_offset: data.next_offset ?? null, has_more: data.has_more ?? null, truncated: data.has_more ?? null, consistency: typeof data.offset === "number" ? "live_offset" : "bounded_result", snapshot: false, warning: "Records may move between pages when edited; deduplicate by id." } };
}
async function extra(context: McpContext, name: string, input: Record<string, unknown>): Promise<Record<string, unknown> | null> {
  if (name === "operation_status") {
    const op = await operationStore(context, "operation", { id: input.operation_id });
    if (op.scope_hash !== requestHash("capabilities", context.capabilities as unknown as Record<string, unknown>)) throw new McpError("permission_denied", "This operation was created under different connection permissions. Review it inside Life OS.");
    return op;
  }
  if (name === "start_scan_job") return operationStore(context, "start_job", { input, capabilities: context.capabilities });
  if (name === "job_status" || name === "job_results") {
    const job = await operationStore(context, "job", { id: input.job_id });
    if (!capabilityAllows(context.capabilities, "lifeos_scan_mail", true, job.input as Record<string, unknown>)) throw new McpError("permission_denied", "This job is outside the current scan permissions.");
    return name === "job_status" ? { ...job, result: undefined, progress: { phase: job.state, percent: null } } : job;
  }
  if (name === "job_cancel") return operationStore(context, "cancel_job", { id: input.job_id });
  if (name === "preview_patch") return operationStore(context, "preview", { table: input.table, id: input.record_id, patch: input.patch, work_streams: context.capabilities.work_streams });
  if (name === "commit_previews") {
    const results: Record<string, unknown>[] = [];
    for (const previewId of input.preview_ids as string[]) {
      try { results.push({ preview_id: previewId, ...await operationStore(context, "commit_preview", { id: previewId, work_streams: context.capabilities.work_streams }) }); }
      catch (error) { results.push({ preview_id: previewId, ...failure(error) }); }
    }
    return { state: results.some(r => r.state === "failed") ? "partial" : "completed", results, atomic_batch: false };
  }
  if (name === "connection_activity") return operationStore(context, "activity");
  if (name === "health") {
    const result: Record<string, unknown> = { capabilities: context.capabilities, recovery: { connections: "/settings", actions: "/assistant", accounts: "/settings" } };
    if (context.capabilities.mailboxes === null && context.capabilities.work_streams === null && context.capabilities.finance && context.capabilities.mail_body) {
      const svc = createServiceClient();
      const [accounts, actions, calendars, scans] = await Promise.all([
        svc.from("accounts").select("slot,status,last_token_use").eq("user_id", context.userId),
        svc.from("assistant_actions").select("id,status,execution_state,undo_started_at,created_at").eq("user_id", context.userId).or(`execution_state.eq.uncertain,undo_started_at.not.is.null,and(status.eq.approved,created_at.lt.${new Date(Date.now()-600000).toISOString()})`).limit(25),
        svc.from("calendars").select("id,last_synced_at,sync_enabled").eq("user_id", context.userId),
        svc.from("audit_log").select("action,ts").eq("user_id", context.userId).in("action", ["cron_scan", "cron_scan_started", "cron_scan_failed"]).order("ts", {ascending:false}).limit(10),
      ]);
      if ([accounts, actions, calendars, scans].some(r => r.error)) throw new McpError("storage_unavailable", "Health data is temporarily unavailable.", true);
      result.accounts = accounts.data; result.possibly_stuck_actions = actions.data;
      result.calendar_sync = calendars.data; result.recent_scan_outcomes = scans.data;

    }
    return result;
  }
  return null;
}
export async function dispatch(context: McpContext, name: string, rawInput: Record<string, unknown>): Promise<Record<string, unknown>> {
  let activity: string | undefined; let operationId: string | undefined;
  try {
    const entry = manifest(context).find(t => t.name === name);
    if (!entry || !capabilityAllows(context.capabilities, name, !entry.read_only, rawInput)) throw new McpError("permission_denied", "This tool or target is not enabled for this connection.");
    validateInput(rawInput, entry.input_schema);
    const input = { ...rawInput }; const suppliedKey = input._idempotency_key; delete input._idempotency_key;
    const call = await operationStore(context, "begin_call", { tool: name }); activity = String(call.id);
    if (!entry.read_only) {
      const hash = requestHash(name, input); const reserved = await operationStore(context, "reserve", { key: suppliedKey ?? randomUUID(), hash, tool: name, scope_hash: requestHash("capabilities", context.capabilities as unknown as Record<string, unknown>) });
      const op = reserved.operation as Record<string, unknown>;
      if (op.request_hash !== hash) throw new McpError("idempotency_conflict", "This key was already used for different input.");
      if (!reserved.claimed) {
        if (op.scope_hash !== requestHash("capabilities", context.capabilities as unknown as Record<string, unknown>)) throw new McpError("permission_denied", "This operation belongs to different connection permissions.");
        await operationStore(context, "finish_call", { id: activity, state: "replayed" });
        return op.result ? { ...(op.result as object), replayed: true } : { state: op.state, operation_id: String(op.id), retryable: false, message: "The original request may still be running. Poll operation_status; do not submit a new key." };
      }
      operationId = String(op.id);
    }
    let data = await extra(context, name.replace(/^lifeos_/, ""), input);
    if (!data) data = entry.read_only ? await runReadTool(name, input, await serviceActor(), context.capabilities.work_streams === null ? undefined : { workStreamIds: context.capabilities.work_streams }) : await runWriteTool(name.replace(/^lifeos_/, ""), input);
    data = pagination(context.capabilities.finance ? data : redactFinance(data) as Record<string, unknown>);
    if (Buffer.byteLength(JSON.stringify(data), "utf8") > 256000) throw new McpError("result_too_large", "The result exceeds 256 KB. Narrow the query or use smaller pages.");
    const actionId = typeof data.action_id === "string" ? data.action_id : null;
    let undoAvailable = false;
    if (actionId) {
      const { data: row } = await createServiceClient().from("assistant_actions").select("result,status").eq("id", actionId).eq("user_id", context.userId).maybeSingle();
      const undo = row?.result && typeof row.result === "object" && !Array.isArray(row.result) ? row.result.undo : null;
      undoAvailable = row?.status === "executed" && !!undo && typeof undo === "object" && !Array.isArray(undo) && Object.keys(undo).length > 0 && undo.kind !== "none";
    }
    const result = { state: data.queued ? "awaiting_approval" : data.state ?? "completed", operation_id: operationId ?? null, action_id: actionId, undo_available: undoAvailable, retryable: false, data, source: "Life OS", fetched_at: new Date().toISOString(), untrusted_content: true };
    if (operationId) await operationStore(context, "finish", { id: operationId, state: "completed", result });
    if (activity) await operationStore(context, "finish_call", { id: activity, state: String(result.state) });
    return result;
  } catch (error) {
    const details = error instanceof Error ? error as Error & { actionId?: string; state?: string } : null;
    const result = { ...failure(error), ...(operationId ? { operation_id: operationId, state: "uncertain", retryable: false } : {}), ...(details?.actionId ? { action_id: details.actionId } : {}) };
    if (operationId) { try { await operationStore(context, "finish", { id: operationId, state: "uncertain", result }); } catch { /* Original intent remains visible for reconciliation. */ } }
    if (activity) { try { await operationStore(context, "finish_call", { id: activity, state: String(result.state) }); } catch { /* The pre-call activity record remains visible. */ } }
    return result;
  }
}
