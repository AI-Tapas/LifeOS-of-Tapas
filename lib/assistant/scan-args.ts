// B24. What a mail scan is asked to do, and the limits that follow. Pure (no
// Supabase, no fetch) so scripts/b24.test.ts can pin it offline. The nightly
// cron passes nothing and gets the old numbers; only a hand-run catch-up
// (the scan_mail tool with days or account) can widen them, and only for
// that one run.

import { slotByKey } from "../accounts.ts";

export const NIGHTLY_DAYS = 3;
export const PER_ACCOUNT_MESSAGES = 15;
// A6: proposals per account per IST day. Five, not twenty: at twenty the
// list filled with bills and notices faster than he could read it.
export const DAILY_TASK_CAP = 5;
export const MAX_SCAN_DAYS = 14;
export const MAX_SCAN_MESSAGES = 150;
// B34: the second, targeted list per mailbox (allowlisted ticket and cab
// receipt senders only), so a busy day of circulars cannot push a ticket out
// of the newest-15 window. Scales with days the way the message cap does.
export const TARGETED_MESSAGES = 10;
export const MAX_TARGETED_MESSAGES = 50;

export interface ScanOptions {
  // Look-back window in days, 1 to 14. Absent means the nightly 3.
  days?: number;
  // One slot name (for example "icai"). Absent means every connected account.
  account?: string;
}

export interface ScanLimits {
  days: number;
  messages: number;
  task_cap: number;
}

// The numbers one run uses. Above the nightly window the message cap grows
// with the days (at most 150) and so does the per-account task cap, for that
// run only; at or below it nothing changes.
export function scanLimits(days?: number): ScanLimits {
  const d = days ?? NIGHTLY_DAYS;
  if (d <= NIGHTLY_DAYS) {
    return { days: d, messages: PER_ACCOUNT_MESSAGES, task_cap: DAILY_TASK_CAP };
  }
  return {
    days: d,
    messages: Math.min(d * PER_ACCOUNT_MESSAGES, MAX_SCAN_MESSAGES),
    task_cap: DAILY_TASK_CAP * d,
  };
}

export function targetedCap(days: number): number {
  return days <= NIGHTLY_DAYS
    ? TARGETED_MESSAGES
    : Math.min(days * TARGETED_MESSAGES, MAX_TARGETED_MESSAGES);
}

// The tool boundary. A model or a connector supplies these, so they are
// checked here rather than trusted: whole days from 1 to 14, and a slot that
// exists. A missing or null value simply means "not given".
export function parseScanArgs(
  input: Record<string, unknown>
): { ok: true; options: ScanOptions } | { ok: false; message: string } {
  const options: ScanOptions = {};
  const rawDays = input.days;
  if (rawDays !== undefined && rawDays !== null) {
    if (
      typeof rawDays !== "number" ||
      !Number.isInteger(rawDays) ||
      rawDays < 1 ||
      rawDays > MAX_SCAN_DAYS
    ) {
      return { ok: false, message: `days must be a whole number from 1 to ${MAX_SCAN_DAYS}.` };
    }
    options.days = rawDays;
  }
  const rawAccount = input.account;
  if (rawAccount !== undefined && rawAccount !== null && rawAccount !== "") {
    if (typeof rawAccount !== "string" || !slotByKey(rawAccount.trim())) {
      return { ok: false, message: "account is not a known account slot." };
    }
    options.account = rawAccount.trim();
  }
  return { ok: true, options };
}

// A window that closed before today gives nothing to do: the 7 AM sweep
// would only drop the task later, so it is never created. Both are
// YYYY-MM-DD, which compare correctly as text.
export function windowAlreadyClosed(lapsesOn: string | null, todayKey: string): boolean {
  return !!lapsesOn && lapsesOn < todayKey;
}

// A short reason a scan run failed, safe for an audit row and the brief. It
// carries a code and a fixed phrase only, never a provider's message body
// and never anything read from mail.
export type ScanFailureCode = "auth" | "provider" | "other";

export class ScanModelError extends Error {
  code: ScanFailureCode;
  constructor(code: ScanFailureCode, message: string) {
    super(message);
    this.name = "ScanModelError";
    this.code = code;
  }
}

// Reads the status off whatever the model layer threw: the Anthropic SDK
// puts it on error.status, the OpenAI path writes "LLM request failed (401)".
export function classifyModelError(e: unknown): ScanModelError {
  const status =
    typeof (e as { status?: unknown })?.status === "number"
      ? ((e as { status: number }).status)
      : Number(/\((\d{3})\)/.exec(e instanceof Error ? e.message : "")?.[1] ?? NaN);
  if (status === 401 || status === 403) {
    return new ScanModelError("auth", `AI key refused (${status})`);
  }
  if (Number.isFinite(status)) {
    return new ScanModelError("provider", `AI provider error (${status})`);
  }
  return new ScanModelError("provider", "AI provider could not be reached");
}
