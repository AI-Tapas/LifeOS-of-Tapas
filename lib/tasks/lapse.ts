// B20. Closed windows lapse.
//
// Tapas, 27 September 2026: early-bird deadlines of 10 September, a "before
// 3 PM" authorisation on 10 September, a 12 September faculty day and a
// 15 September e-vote window were all still open. Nothing ever lapsed an
// ordinary task. tasks.lapses_on says when a window is simply gone; the 7 AM
// brief cron drops (never deletes) an open task once that IST date has
// passed, in one undoable action, and says how many in the brief.
//
// A task with no lapses_on is NEVER touched here, however overdue: a
// statutory, client or payment deadline stays open until he decides.
// Pure and dependency-injected so scripts/b20.test.ts proves it offline.

export interface LapseTask {
  id: string;
  status: string;
  lapses_on: string | null;
}

const OPEN = new Set(["inbox", "todo", "doing"]);

// Open tasks whose window closed before todayKey (YYYY-MM-DD, IST). The
// lapse date itself is still a live day.
export function lapsedTasks<T extends LapseTask>(tasks: T[], todayKey: string): T[] {
  return tasks.filter((t) => OPEN.has(t.status) && !!t.lapses_on && t.lapses_on < todayKey);
}

export interface LapseUndo {
  tasks: { id: string; status: string }[];
}

export async function sweepLapsed(
  setStatus: (id: string, status: "dropped") => Promise<boolean>,
  tasks: LapseTask[],
  todayKey: string
): Promise<LapseUndo> {
  const undo: LapseUndo = { tasks: [] };
  for (const t of lapsedTasks(tasks, todayKey)) {
    if (await setStatus(t.id, "dropped")) undo.tasks.push({ id: t.id, status: t.status });
  }
  return undo;
}

export interface LapseUndoDeps {
  currentStatus(id: string): Promise<string | null>;
  setStatus(id: string, status: string): Promise<void>;
}

// Each task goes back to the status it had, but only while it is still
// dropped: one he has reopened or finished since is left where he put it.
export async function undoLapse(deps: LapseUndoDeps, undo: Record<string, unknown>): Promise<void> {
  const list = Array.isArray(undo.tasks) ? undo.tasks : [];
  for (const item of list) {
    const t = (item ?? {}) as Record<string, unknown>;
    if (typeof t.id !== "string" || typeof t.status !== "string" || !OPEN.has(t.status)) continue;
    if ((await deps.currentStatus(t.id)) !== "dropped") continue;
    await deps.setStatus(t.id, t.status);
  }
}

export function lapsedLine(count: number): string | null {
  if (!count) return null;
  return `${count} closed ${count === 1 ? "window" : "windows"} dropped.`;
}

export function ticketsWithoutTripLine(count: number): string | null {
  if (!count) return null;
  return `${count} ticket ${count === 1 ? "email" : "emails"} did not match a trip.`;
}
