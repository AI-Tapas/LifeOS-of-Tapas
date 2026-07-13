// Task status transitions (M3 defect D2). Every status change, whether it
// comes from the quick done toggle or the Edit-task form, flows through
// runStatusTransition so both surfaces share one set of semantics:
//
//   into done:    set completed_at, remove the reminder event, spawn the next
//                 occurrence when recurring_rule is set (on the transition only)
//   into dropped: clear completed_at, remove the reminder event, never spawn
//                 (dropping ends the series deliberately)
//   reopening:    clear completed_at, recreate the reminder only while due_ts
//                 is still in the future, never spawn
//
// Spawning is guarded twice: it runs only when the previous status was not
// already done, and applyStatus is a compare-and-swap on the previous status,
// so a doubly submitted transition claims the row exactly once. Dependencies
// are injected so the orchestration is provable offline (scripts/m3.test.ts),
// the same pattern as runReminderCleanup and resourceWithReauth.

import type { Database } from "@/lib/database.types";

type TaskStatus = Database["public"]["Enums"]["task_status"];

export function isFinishedStatus(status: TaskStatus): boolean {
  return status === "done" || status === "dropped";
}

export interface TransitionTaskState {
  status: TaskStatus;
  due_ts: string | null;
  recurring_rule: string | null;
}

export interface ReminderSyncOutcome {
  created: boolean;
  reason?: string;
}

export interface TransitionDeps {
  // Current status, due_ts and recurring_rule of the task; null when missing.
  readTask(): Promise<TransitionTaskState | null>;
  // Compare-and-swap status write: sets next (and completed_at when the value
  // is not undefined) only while the row still holds prev. Resolves true when
  // this call claimed the row.
  applyStatus(
    prev: TaskStatus,
    next: TaskStatus,
    completedAt: string | null | undefined
  ): Promise<boolean>;
  // Status-aware reminder sync: removes the event for done or dropped tasks,
  // writes or refreshes it otherwise (lib/reminders/writer.ts).
  syncReminder(): Promise<ReminderSyncOutcome | null>;
  // Creates the next occurrence of a recurring task, with its own reminder.
  spawnNext(): Promise<string | undefined>;
  now(): Date;
}

export interface TransitionOutcome {
  ok: boolean;
  message?: string;
  reminderNote?: string;
  spawned: boolean;
}

function noteFrom(outcome: ReminderSyncOutcome | null): string | undefined {
  if (outcome && !outcome.created && outcome.reason) return outcome.reason;
  return undefined;
}

export async function runStatusTransition(
  deps: TransitionDeps,
  nextStatus: TaskStatus
): Promise<TransitionOutcome> {
  try {
    const task = await deps.readTask();
    if (!task) return { ok: false, message: "Task not found.", spawned: false };
    const prev = task.status;

    // No transition: a repeated save of an already-done task lands here.
    // completed_at stays untouched, nothing spawns, and the reminder resync
    // is idempotent: it removes for finished tasks and refreshes for active
    // ones.
    if (prev === nextStatus) {
      return {
        ok: true,
        reminderNote: noteFrom(await deps.syncReminder()),
        spawned: false,
      };
    }

    const enteringDone = nextStatus === "done";
    const enteringDropped = nextStatus === "dropped";
    const reopening = isFinishedStatus(prev) && !isFinishedStatus(nextStatus);
    const completedAt = enteringDone
      ? deps.now().toISOString()
      : enteringDropped || reopening
        ? null
        : undefined;

    const claimed = await deps.applyStatus(prev, nextStatus, completedAt);
    if (!claimed) {
      // A concurrent submission moved the row first; its transition owns the
      // side effects. This one only leaves the reminder consistent.
      return {
        ok: true,
        reminderNote: noteFrom(await deps.syncReminder()),
        spawned: false,
      };
    }

    let reminderNote: string | undefined;
    if (enteringDone || enteringDropped) {
      // Remove this occurrence's reminder before any spawn, so a failure can
      // never leave both the old event and the next occurrence's event behind.
      await deps.syncReminder();
    } else if (reopening) {
      // Recreate only while the due date is ahead. A past-due reopen would
      // otherwise write an event whose notifications are already spent.
      if (task.due_ts && new Date(task.due_ts).getTime() > deps.now().getTime()) {
        reminderNote = noteFrom(await deps.syncReminder());
      }
    } else {
      // Active-to-active move: the due date or offsets may have changed.
      reminderNote = noteFrom(await deps.syncReminder());
    }

    let spawnNote: string | undefined;
    if (enteringDone && task.recurring_rule) {
      spawnNote = await deps.spawnNext();
    }
    return {
      ok: true,
      reminderNote: spawnNote ?? reminderNote,
      spawned: spawnNote !== undefined,
    };
  } catch (e) {
    return {
      ok: false,
      message: e instanceof Error ? e.message : "Could not update the task.",
      spawned: false,
    };
  }
}
