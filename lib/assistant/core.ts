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
import { SEND_CLASS, type ToolDisclosure } from "./tools.ts";
import { cleanReason, isPriority, type TaskPriority } from "../tasks/priority.ts";

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

// ---------------------------------------------------------------------------
// Disclosure gate (B8). The bucket says what a tool may change; the disclosure
// class says what it may see. Exactly one class reads message bodies, and a
// body read is only ever legitimate as its own top-level act: Tapas asked for
// a scan, or the nightly cron ran one. Reached as a silent step inside another
// tool's execution, it would pull mail content into work nobody asked for, so
// it is refused there. Pure, so scripts/m4.test.ts proves it offline.
// ---------------------------------------------------------------------------
export function checkDisclosure(
  disclosure: ToolDisclosure,
  nestedInsideAnotherTool: boolean
): GateOutcome {
  if (disclosure === "mail_body" && nestedInsideAnotherTool) {
    return {
      ok: false,
      message:
        "Reading mail is its own act, never a step inside another one. Ask for a mail scan directly.",
    };
  }
  return { ok: true };
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

// ---------------------------------------------------------------------------
// Fail closed when the affected object cannot be resolved (B10).
//
// An autonomous grant has until now been attached to the tool name alone: any
// call to update_task ran under the autonomous bucket, whatever it was pointed
// at. It should be attached to the tool AND to the thing it acts on. A call
// whose target does not resolve to something the owner actually has does not
// inherit the grant. It does not run, and it does not quietly do nothing
// either: it lands in the queue as proposed, carrying the reason, where Tapas
// can see that the assistant tried and what it could not find.
//
// Dependency-injected, so scripts/m4.test.ts proves it offline exactly the way
// runApprovedExecution is proved.
// ---------------------------------------------------------------------------

// How one autonomous tool's target is derived: the input key that names it,
// and the word for it in the reason Tapas reads.
export interface TargetSpec {
  arg: string;
  label: string;
}

export interface AutonomousDeps<T> {
  // True when the named target exists and belongs to the owner. False when the
  // lookup came back empty, which is a downgrade, never an error to swallow.
  resolveTarget(value: string): Promise<boolean>;
  perform(): Promise<T>;
  recordExecuted(done: T): Promise<{ actionId: string | null }>;
  // Insert the proposed row that carries the reason.
  downgrade(reason: string): Promise<{ actionId: string }>;
}

export type AutonomousOutcome<T> =
  | { basis: "autonomous_bucket"; actionId: string | null; done: T }
  | { basis: "downgraded_to_queue"; actionId: string; reason: string };

export async function runAutonomousAction<T>(
  input: Record<string, unknown>,
  spec: TargetSpec | undefined,
  deps: AutonomousDeps<T>
): Promise<AutonomousOutcome<T>> {
  if (spec) {
    const raw = input[spec.arg];
    const value = typeof raw === "string" ? raw.trim() : "";
    // A missing argument is a malformed call rather than an unresolvable
    // target: the performer refuses it with a message the model can act on,
    // and nothing reaches the queue. Only a lookup that came back empty is a
    // downgrade, because there the model named something and it was not there.
    if (value && !(await deps.resolveTarget(value))) {
      const reason = `The ${spec.label} "${value}" could not be resolved, so nothing was done.`;
      const { actionId } = await deps.downgrade(reason);
      return { basis: "downgraded_to_queue", actionId, reason };
    }
  }
  const done = await deps.perform();
  const { actionId } = await deps.recordExecuted(done);
  return { basis: "autonomous_bucket", actionId, done };
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
  // Validated exactly the way work_stream is: one of the three real values or
  // nothing. The mail this came from is untrusted text, so a priority is only
  // accepted when it names a real value AND carries a reason. Without a
  // reason there is nothing for Tapas to disagree with, so the pair is
  // dropped and the task lands unrated rather than silently rated.
  priority: TaskPriority | null;
  priority_reason: string | null;
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
    const priorityRaw = call.input.priority;
    const reason = cleanReason(
      typeof call.input.priority_reason === "string" ? call.input.priority_reason : null
    );
    const priority = isPriority(priorityRaw) && reason ? priorityRaw : null;
    if (priorityRaw !== undefined && priorityRaw !== null && !priority) {
      rejected.push(
        `priority dropped for ${ref}: ${
          isPriority(priorityRaw) ? "no reason given" : "not one of low, medium, high"
        }`
      );
    }
    seenRefs.add(ref);
    accepted.push({
      title: title.slice(0, 140),
      note: noteRaw ? noteRaw.slice(0, 500) : null,
      external_ref: ref,
      due_date: /^\d{4}-\d{2}-\d{2}$/.test(dueRaw) ? dueRaw : null,
      work_stream: streamByKey.get(streamRaw.toLowerCase()) ?? null,
      priority,
      priority_reason: priority ? reason : null,
    });
  }
  return { accepted, rejected };
}
