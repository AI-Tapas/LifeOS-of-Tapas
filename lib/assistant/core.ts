// Pure approval-gate logic, dependency-injected so scripts/m4.test.ts proves
// it offline (the same pattern as runStatusTransition and resourceWithReauth).
//
// The gate (red-team control 1): approval is a server-side fact the model
// cannot create. An action executes only when
//   1. its status is 'approved' (set only by an owner-session server action),
//   2. the payload's hash matches the hash recorded at approval time
//      (approve-then-mutate, A7),
//   3. this call wins the compare-and-swap claim (idempotency: a double
//      submit executes at most once),
// and only send-class kinds route through here at all. The model holds no
// tool that mutates assistant_actions.status; the DB trigger additionally
// freezes the payload once status leaves 'proposed'.

import { createHash } from "node:crypto";
// Explicit .ts extension so node --test (type stripping, no bundler) can
// resolve it; allowImportingTsExtensions covers the Next side.
import { SEND_CLASS } from "./tools.ts";

// Canonical JSON: object keys sorted at every depth, so semantically equal
// payloads hash equally regardless of key order.
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return "[" + value.map(canonicalJson).join(",") + "]";
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return (
    "{" +
    keys
      .filter((k) => obj[k] !== undefined)
      .map((k) => JSON.stringify(k) + ":" + canonicalJson(obj[k]))
      .join(",") +
    "}"
  );
}

export function hashPayload(payload: unknown): string {
  return createHash("sha256").update(canonicalJson(payload), "utf8").digest("hex");
}

export interface GateActionRow {
  id: string;
  kind: string;
  status: string;
  payload: unknown;
  payload_hash: string | null;
}

export interface ApprovedExecutionDeps {
  loadAction(): Promise<GateActionRow | null>;
  // Compare-and-swap claim: stamps executed_at only while it is still null and
  // status is still 'approved'. Resolves true when this call claimed the row.
  claimExecution(): Promise<boolean>;
  // The real side effect (send the mail, create the invite event).
  perform(kind: string, payload: unknown): Promise<unknown>;
  markExecuted(result: unknown): Promise<void>;
  markFailed(message: string): Promise<void>;
  audit(action: string, meta: Record<string, unknown>): Promise<void>;
}

export type GateOutcome =
  | { ok: true }
  | { ok: false; message: string };

export async function runApprovedExecution(
  deps: ApprovedExecutionDeps
): Promise<GateOutcome> {
  const action = await deps.loadAction();
  if (!action) return { ok: false, message: "Action not found." };
  if (!SEND_CLASS.has(action.kind)) {
    return {
      ok: false,
      message: `${action.kind} does not execute through the approval queue.`,
    };
  }
  if (action.status !== "approved") {
    return {
      ok: false,
      message: `This action is ${action.status}, not approved. Nothing was sent.`,
    };
  }
  if (!action.payload_hash || hashPayload(action.payload) !== action.payload_hash) {
    await deps.audit("execute_refused_hash_mismatch", { action_id: action.id });
    return {
      ok: false,
      message:
        "The payload changed after approval, so it was refused. Review and approve it again.",
    };
  }
  if (!(await deps.claimExecution())) {
    return { ok: false, message: "Already executed, or its state changed." };
  }
  try {
    const result = await deps.perform(action.kind, action.payload);
    await deps.markExecuted(result);
    await deps.audit("execute", { action_id: action.id, kind: action.kind });
    return { ok: true };
  } catch (e) {
    const message = e instanceof Error ? e.message : "Execution failed.";
    await deps.markFailed(message);
    await deps.audit("execute_failed", { action_id: action.id, reason: message });
    return { ok: false, message };
  }
}

// Calendar invitations, their replies and cancellations are already handled by
// the calendar itself, so they must never become tasks. Gmail marks them with
// a text/calendar part, which is decisive; the subject prefixes catch the
// Microsoft side and any forwarded copies. Pure, so scripts/m4.test.ts can
// prove it offline.
const INVITE_SUBJECT =
  /^\s*(re:\s*)?(invitation|updated invitation|invite|accepted|declined|tentative|cancelled event|canceled event|cancelled|canceled|new time proposed|meeting forward notification)\s*:/i;

export function isCalendarInvite(mail: {
  subject?: string;
  contentType?: string;
}): boolean {
  if (mail.contentType && /text\/calendar/i.test(mail.contentType)) return true;
  return INVITE_SUBJECT.test(mail.subject ?? "");
}

// ---------------------------------------------------------------------------
// Mail-scan proposal validation (pure). The scanner's LLM context holds ONE
// tool; everything else it might emit is discarded here, so an injected
// instruction in a mail body can at most yield a proposed task (A1), never a
// send or a draft. external_ref must be one of the refs we actually scanned,
// so a proposal cannot point at fabricated provenance.
// ---------------------------------------------------------------------------
export interface ScanProposal {
  title: string;
  note: string | null;
  external_ref: string;
  due_date: string | null;
  // One of the user's real stream names, or null to take the account default.
  work_stream: string | null;
}

export interface RawToolCall {
  name: string;
  input: Record<string, unknown>;
}

export function validateScanProposals(
  calls: RawToolCall[],
  knownRefs: Set<string>,
  remainingBudget: number,
  // The user's real work stream names. A proposal may name one, but only one
  // of these: the model is reading untrusted mail, so the value is matched
  // against the list rather than trusted. Anything else falls back to the
  // account's default stream, chosen by the caller.
  allowedStreams: string[] = []
): { accepted: ScanProposal[]; rejected: string[] } {
  const streamByKey = new Map(allowedStreams.map((s) => [s.trim().toLowerCase(), s]));
  const accepted: ScanProposal[] = [];
  const rejected: string[] = [];
  const seenRefs = new Set<string>();

  for (const call of calls) {
    if (call.name !== "propose_task") {
      rejected.push(`tool ${call.name} is not available to the mail scanner`);
      continue;
    }
    const title = typeof call.input.title === "string" ? call.input.title.trim() : "";
    const ref =
      typeof call.input.external_ref === "string" ? call.input.external_ref : "";
    if (!title) {
      rejected.push("proposal without a title");
      continue;
    }
    if (!knownRefs.has(ref)) {
      rejected.push(`unknown message ref ${ref || "(missing)"}`);
      continue;
    }
    if (seenRefs.has(ref)) {
      rejected.push(`duplicate proposal for ${ref}`);
      continue;
    }
    if (accepted.length >= remainingBudget) {
      rejected.push(`daily cap reached, skipped: ${title.slice(0, 60)}`);
      continue;
    }
    const noteRaw = typeof call.input.note === "string" ? call.input.note.trim() : "";
    const dueRaw =
      typeof call.input.due_date === "string" ? call.input.due_date : "";
    const streamRaw =
      typeof call.input.work_stream === "string" ? call.input.work_stream.trim() : "";
    seenRefs.add(ref);
    accepted.push({
      title: title.slice(0, 140),
      note: noteRaw ? noteRaw.slice(0, 500) : null,
      external_ref: ref,
      due_date: /^\d{4}-\d{2}-\d{2}$/.test(dueRaw) ? dueRaw : null,
      work_stream: streamByKey.get(streamRaw.toLowerCase()) ?? null,
    });
  }
  return { accepted, rejected };
}
