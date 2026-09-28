// B22. The task fields the assistant and both connectors gained: billable,
// project and recurrence, plus the undo snapshot that puts every field back.
//
// Pure (relative .ts imports only), so scripts/b22.test.ts proves the checks
// and the undo offline. lib/tasks/write.ts still validates the rule itself on
// every write; this refuses a bad one earlier with a message a model can act
// on, and it is the only place a project id is checked against his projects.

import { parseRecurringRule } from "./recurring.ts";
import { isReminderMode } from "../reminders/core.ts";
import type { TaskInput } from "./write.ts";

export interface ProjectRef {
  id: string;
  name: string;
}

export type ExtrasResult =
  | { ok: true; patch: Pick<Partial<TaskInput>, "project_id" | "recurring_rule" | "is_billable"> }
  | { ok: false; message: string };

export const RECURRING_RULE_DESC =
  "How the task repeats, as <freq> or <freq>:<interval>, where freq is daily, weekly, monthly or yearly: e.g. monthly, weekly:2 (fortnightly), yearly. Completing one occurrence creates the next.";

// Only keys the caller sent are in the patch. An empty string clears a
// project or a rule; anything else must be real.
export function resolveTaskExtras(
  input: Record<string, unknown>,
  projects: ProjectRef[]
): ExtrasResult {
  const patch: Pick<Partial<TaskInput>, "project_id" | "recurring_rule" | "is_billable"> = {};
  if (typeof input.project_id === "string") {
    const id = input.project_id.trim();
    if (!id) {
      patch.project_id = null;
    } else if (!projects.some((p) => p.id === id)) {
      const names = projects.map((p) => `${p.name} (${p.id})`).join(", ");
      return {
        ok: false,
        message: `There is no project with id ${id}.${names ? ` His projects: ${names}.` : " He has no projects yet."}`,
      };
    } else {
      patch.project_id = id;
    }
  }
  if (typeof input.recurring_rule === "string") {
    const rule = input.recurring_rule.trim().toLowerCase();
    if (!rule) {
      patch.recurring_rule = null;
    } else if (!parseRecurringRule(rule)) {
      return {
        ok: false,
        message: `"${input.recurring_rule}" is not a recurring rule. ${RECURRING_RULE_DESC}`,
      };
    } else {
      patch.recurring_rule = rule;
    }
  }
  if (typeof input.billable === "boolean") patch.is_billable = input.billable;
  return { ok: true, patch };
}

// Every column update_task can change, read before the change, so undo can
// put each one back.
export const TASK_UNDO_COLUMNS =
  "title, notes, status, priority, priority_source, priority_reason, due_ts, not_before, lapses_on, work_stream_id, remind_offsets, reminder_mode, trip_id, is_billable, project_id, recurring_rule";

// The patch that restores a snapshot. A snapshot written before a column was
// added (B19, B20, B22) has no key for it, and then the column is left alone
// rather than cleared.
export function taskUndoPatch(prev: Record<string, unknown>): Partial<TaskInput> {
  return {
    title: prev.title as string | undefined,
    notes: (prev.notes as string | null | undefined) ?? null,
    status: prev.status as TaskInput["status"],
    priority: prev.priority as TaskInput["priority"],
    priority_source: prev.priority_source as TaskInput["priority_source"],
    priority_reason: (prev.priority_reason as string | null | undefined) ?? null,
    due_ts: (prev.due_ts as string | null | undefined) ?? null,
    ...("not_before" in prev ? { not_before: (prev.not_before as string | null) ?? null } : {}),
    ...("lapses_on" in prev ? { lapses_on: (prev.lapses_on as string | null) ?? null } : {}),
    ...(typeof prev.work_stream_id === "string" ? { work_stream_id: prev.work_stream_id } : {}),
    remind_offsets: prev.remind_offsets as number[] | undefined,
    reminder_mode: isReminderMode(prev.reminder_mode) ? prev.reminder_mode : undefined,
    trip_id: (prev.trip_id as string | null | undefined) ?? null,
    ...("is_billable" in prev ? { is_billable: prev.is_billable === true } : {}),
    ...("project_id" in prev ? { project_id: (prev.project_id as string | null) ?? null } : {}),
    ...("recurring_rule" in prev
      ? { recurring_rule: (prev.recurring_rule as string | null) ?? null }
      : {}),
  };
}
