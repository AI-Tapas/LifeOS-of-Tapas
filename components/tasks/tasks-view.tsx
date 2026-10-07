"use client";

import { createContext, useContext, useMemo, useRef, useState, useSyncExternalStore, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  BandHead,
  Drawer,
  DueBadge,
  Empty,
  Field,
  PageHeader,
  PriorityReason,
  RemindChips,
  SectionLabel,
  btnPrimary,
  drawerFooterCls,
  inputCls,
} from "@/components/ui";
import { formatDateIST, formatDateShortIST, formatTimeIST, istInstant, istDayKey } from "@/lib/datetime";
import { agentMarker, agentStatusLine } from "@/lib/tasks/agent-display";
import { INSTRUCTION_MAX } from "@/lib/tasks/agent-limits";
import { triage, needsDeadline, isWaiting, waitingLine } from "@/lib/tasks/triage";
import { unratedPrompt, type PrioritySource } from "@/lib/tasks/priority";
import { rollUpTrips, type TripRollup, type TripStep } from "@/lib/tasks/trip-rollup";
import {
  createTaskAction,
  updateTaskAction,
  setTaskStatusAction,
  deleteTaskAction,
  quickAddTaskAction,
  createProjectAction,
  updateProjectAction,
  deleteProjectAction,
  moveTaskOnBoardAction,
} from "@/app/(app)/tasks/actions";
import { BOARD_STATUSES, columnCards, placeCard, type BoardStatus } from "@/lib/tasks/board";
import { setBillingStateAction } from "@/app/(app)/unbilled/actions";
import { REF_MAX, type BillingState } from "@/lib/billing/unbilled";
import type { TaskInput } from "@/lib/tasks/write";
import { parseHours, formatHours } from "@/lib/hours/parse";

export interface TaskRow {
  id: string;
  title: string;
  notes: string | null;
  status: "inbox" | "todo" | "doing" | "done" | "dropped";
  priority: "low" | "medium" | "high";
  // Whose judgment the priority is, and the one short sentence behind it.
  // Optional so the dev-preview fixtures stay small; a row without them
  // simply shows no attribution, which is what an unrated task should show.
  priority_source?: PrioritySource;
  priority_reason?: string | null;
  due_ts: string | null;
  // The first day it can start (B19), an IST date. Until then the overview
  // counts it instead of ranking it. Optional so the dev-preview fixtures
  // stay small; a row without it is available now.
  not_before?: string | null;
  work_stream_id: string;
  project_id: string | null;
  // A checklist step of a trip. It keeps its own due date and reminder, but
  // the overview shows the trip's rolled-up line in its place.
  trip_id: string | null;
  recurring_rule: string | null;
  is_billable: boolean;
  // B30. Per-task override of the stream's billable tick (null: follow the
  // stream), and where this task's billing stands. Optional so the dev-preview
  // fixtures stay small.
  billable?: boolean | null;
  // B32. Hours he spent; null or absent means not logged.
  hours_spent?: number | null;
  billing_state?: string | null;
  billing_ref?: string | null;
  remind_offsets: number[];
  // Whether this task interrupts him on the calendar. Optional so the
  // dev-preview fixtures stay small; a row without it reads as 'calendar',
  // which is what every task did before M7a.
  reminder_mode?: "calendar" | "in_app";
  // B26. Tapas's instruction to his agents and what they answered. All
  // optional so the dev-preview fixtures stay small. agent_pending is worked
  // out on the server (it needs the hash) and handed down as a boolean.
  agent_instructions?: string | null;
  agent_status?: string | null;
  agent_result?: string | null;
  agent_result_at?: string | null;
  agent_pending?: boolean;
  // His order inside a board column; null or absent means not placed by hand.
  board_position?: number | null;
}
export interface ProjectRow {
  id: string;
  name: string;
  work_stream_id: string;
  status: "active" | "on_hold" | "done" | "dropped";
  notes: string | null;
}
export interface WorkStreamRow {
  id: string;
  name: string;
}

type Tab = "overview" | "inbox" | "board" | "projects";

// Inbox is a status, Board holds the remaining statuses, and Projects is a
// grouping that cuts across both. Saying so beats guessing from four nouns.
const TAB_HINTS: Record<Tab, string> = {
  overview: "Ranked the way you asked: urgent and important, then important, then urgent.",
  inbox: "Newly captured, not yet sorted. Move each one to To do, or edit it.",
  board: "Drag a card by its grip to another column, or up and down to set your own order.",
  projects: "Related tasks grouped together. A task can sit in any status.",
};

// "Now" is fixed by the server render and handed down, never read from the
// clock while rendering. Urgency (triage) and the due badge both move with the
// clock, so a client that reads its own Date.now() during hydration disagrees
// with the HTML it is hydrating and React throws the whole tree away.
const NowContext = createContext("");

const PRIORITY_DOT: Record<TaskRow["priority"], string> = {
  low: "#94a3b8",
  medium: "#eab308",
  high: "#dc2626",
};

interface TasksViewProps {
  tasks: TaskRow[];
  // Every task carrying a trip_id, whatever its status, with its trip.
  tripSteps: TripStep[];
  projects: ProjectRow[];
  workStreams: WorkStreamRow[];
  // A task to open on arrival, from /tasks?task=<id>. There is no page for a
  // single task, so a note referencing one links here and the drawer opens.
  // An id that matches nothing simply opens nothing.
  openTaskId?: string;
  // B26. Arrived from the Home line: only tasks agents have asked him about.
  agentFilter?: boolean;
  // B32: show only this month's finished billable tasks with no hours.
  hoursFilter?: boolean;
}

export default function TasksView({
  nowIso,
  ...props
}: TasksViewProps & { nowIso: string }) {
  return (
    <NowContext value={nowIso}>
      <TasksBody {...props} />
    </NowContext>
  );
}

function TasksBody({
  tasks,
  tripSteps,
  projects,
  workStreams,
  openTaskId,
  agentFilter,
  hoursFilter,
}: TasksViewProps) {
  const [tab, setTab] = useState<Tab>(agentFilter || hoursFilter ? "board" : "overview");
  const [editing, setEditing] = useState<TaskRow | "new" | null>(
    () => tasks.find((t) => t.id === openTaskId) ?? null
  );
  const [notice, setNotice] = useState<string | null>(null);

  const wsById = useMemo(
    () => new Map(workStreams.map((w) => [w.id, w.name])),
    [workStreams]
  );
  const projById = useMemo(() => new Map(projects.map((p) => [p.id, p.name])), [projects]);

  return (
    <div>
      <PageHeader
        title="Tasks"
        action={
          <button onClick={() => setEditing("new")} className={btnPrimary}>
            + Task
          </button>
        }
      />

      <div className="mt-3 flex gap-1">
        {(["overview", "inbox", "board", "projects"] as Tab[]).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            aria-pressed={t === tab}
            className={
              "press min-h-11 rounded-full px-3.5 text-sm capitalize " +
              (t === tab
                ? "bg-accent text-white dark:text-neutral-950"
                : "border border-border-strong text-secondary")
            }
          >
            {t}
          </button>
        ))}
      </div>

      <p className="mt-2 text-xs text-secondary">{TAB_HINTS[tab]}</p>

      {agentFilter && (
        <p className="mt-2 rounded-lg border border-border bg-surface p-2 text-xs text-secondary">
          Showing only the tasks where agents need you.{" "}
          <Link href="/tasks" className="font-medium text-accent">
            Show all
          </Link>
        </p>
      )}

      {hoursFilter && (
        <p className="mt-2 rounded-lg border border-border bg-surface p-2 text-xs text-secondary">
          Showing this month&apos;s finished billable tasks with no hours logged. Open one to add them.{" "}
          <Link href="/tasks" className="font-medium text-accent">
            Show all
          </Link>
        </p>
      )}

      {notice && (
        <p className="mt-3 rounded-lg border border-today/30 bg-today-soft p-2 text-xs text-today">
          {notice}
        </p>
      )}

      <div className="mt-4">
        {tab === "overview" && (
          <OverviewTab
            tasks={tasks}
            tripSteps={tripSteps}
            workStreams={workStreams}
            wsById={wsById}
            projById={projById}
            onEdit={setEditing}
            onNotice={setNotice}
            onGoTo={setTab}
          />
        )}
        {tab === "inbox" && (
          <InboxTab
            tasks={tasks}
            workStreams={workStreams}
            wsById={wsById}
            projById={projById}
            onEdit={setEditing}
            onNotice={setNotice}
          />
        )}
        {tab === "board" && (
          <BoardTab
            tasks={tasks}
            wsById={wsById}
            projById={projById}
            onEdit={setEditing}
            onNotice={setNotice}
          />
        )}
        {tab === "projects" && (
          <ProjectsTab
            tasks={tasks}
            projects={projects}
            workStreams={workStreams}
            wsById={wsById}
            onEdit={setEditing}
            onNotice={setNotice}
          />
        )}
      </div>

      {editing && (
        <TaskForm
          task={editing === "new" ? null : editing}
          projects={projects}
          workStreams={workStreams}
          onClose={() => setEditing(null)}
          onNotice={setNotice}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
function TaskItem({
  task,
  wsById,
  projById,
  onEdit,
  onNotice,
  extraActions,
  wrapTitle,
}: {
  task: TaskRow;
  wsById: Map<string, string>;
  projById: Map<string, string>;
  onEdit: (t: TaskRow) => void;
  onNotice: (s: string | null) => void;
  extraActions?: React.ReactNode;
  // Board card: title wraps, badges drop below it, no tick button.
  wrapTitle?: boolean;
}) {
  const router = useRouter();
  const nowIso = useContext(NowContext);
  const [pending, startTransition] = useTransition();
  // Marked locally the moment the tap lands, so the tick pops and the row
  // settles here rather than only on the server round trip. Rolled back if the
  // write fails.
  const [justDone, setJustDone] = useState(false);

  function complete() {
    setJustDone(true);
    startTransition(async () => {
      const r = await setTaskStatusAction(task.id, "done");
      if (r.ok && r.reminderNote) onNotice(r.reminderNote);
      else if (!r.ok) {
        onNotice(r.message);
        setJustDone(false);
      }
      router.refresh();
    });
  }

  const done = task.status === "done" || justDone;
  const badges = (
    <>
      {agentMarker(task) && (
        <span className="shrink-0 rounded-full bg-waiting-soft px-2 py-0.5 text-[10px] font-semibold text-waiting">
          {agentMarker(task)}
        </span>
      )}
      <span className={wrapTitle ? "" : "ml-auto pl-1"}>
        <DueBadge dueTs={task.due_ts} nowIso={nowIso} flagMissing={task.priority === "high" && !done} />
      </span>
    </>
  );
  return (
    <div
      className={
        "flex items-center gap-1 rounded-lg border border-border bg-surface p-1.5 shadow-[var(--shadow-card)]" +
        (justDone ? " settle-done" : "")
      }
    >
      {/* Board cards skip the tick: the Done column does that job, and a
          phone-width column needs the room for the title. */}
      {!wrapTitle && (
        <button
          onClick={complete}
          disabled={pending || done}
          className={
            "press flex h-11 w-11 shrink-0 items-center justify-center rounded-full disabled:opacity-60 " +
            (done ? "pop-done" : "")
          }
          aria-label="Mark done"
          title="Mark done"
        >
          <span
            className={
              "h-5 w-5 rounded-full border-2 " +
              (done ? "border-ok bg-ok" : "border-border-strong")
            }
          />
        </button>
      )}
      <button
        onClick={() => onEdit(task)}
        className={"min-w-0 flex-1 py-1.5 text-left" + (wrapTitle ? " pl-1.5" : "")}
      >
        <div className={wrapTitle ? "flex items-baseline gap-2" : "flex items-center gap-2"}>
          <span
            className="inline-block h-2 w-2 shrink-0 rounded-full"
            style={{ backgroundColor: PRIORITY_DOT[task.priority] }}
            title={`${task.priority} priority`}
          />
          <span
            className={
              (wrapTitle ? "break-words " : "truncate ") +
              "text-sm " +
              (done ? "line-through text-neutral-400" : "")
            }
          >
            {task.title}
          </span>
          {!wrapTitle && badges}
        </div>
        {/* Narrow board cards: the badges get their own line so the title keeps the width. */}
        {wrapTitle && <div className="mt-1 flex flex-wrap items-center gap-1.5">{badges}</div>}
        <div className="mt-0.5 flex flex-wrap gap-x-2 text-[11px] text-neutral-500">
          <span>{wsById.get(task.work_stream_id) ?? "No stream"}</span>
          {task.project_id && <span>{projById.get(task.project_id)}</span>}
          {task.due_ts && (
            <span>
              due {formatDateIST(task.due_ts)}, {formatTimeIST(task.due_ts)}
            </span>
          )}
          {task.not_before && isWaiting(task, Date.parse(nowIso)) && (
            <span>starts {formatDateIST(`${task.not_before}T04:00:00Z`)}</span>
          )}
          {task.recurring_rule && <span>repeats {task.recurring_rule}</span>}
          {task.billable === true && <span>billable</span>}
        </div>
        <PriorityReason
          reason={task.priority_reason}
          source={task.priority_source}
          className="mt-0.5"
        />
      </button>
      {extraActions}
    </div>
  );
}

// A task row, or a trip standing in for its checklist. Both are ranked by
// the same triage call, so a trip lands where its most urgent step would.
type OverviewItem =
  | (TaskRow & { rollup?: undefined })
  | (TripRollup & { rollup: TripRollup });

// One trip, one line: the count, the step it is waiting on, and the due badge
// of that step. Nothing to tick here; the steps live on the trip screen, one
// tap away.
function TripRollupItem({ rollup }: { rollup: TripRollup }) {
  const nowIso = useContext(NowContext);
  return (
    <Link
      href={`/trips/${rollup.trip_id}`}
      className="press flex items-center gap-1 rounded-lg border border-border bg-surface p-1.5 shadow-[var(--shadow-card)]"
    >
      <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-brand-soft text-[9px] font-bold uppercase tracking-[0.08em] text-brand-deep">
        Trip
      </span>
      <span className="min-w-0 flex-1 py-1.5">
        <span className="flex items-center gap-2">
          <span className="truncate text-sm">{rollup.label}</span>
          <span className="ml-auto pl-1">
            <DueBadge dueTs={rollup.due_ts} nowIso={nowIso} flagMissing={false} />
          </span>
        </span>
        <span className="mt-0.5 block text-[11px] text-neutral-500">
          {rollup.progress}, next: {rollup.next_title}
        </span>
      </span>
    </Link>
  );
}

function OverviewTab({
  tasks,
  tripSteps,
  workStreams,
  wsById,
  projById,
  onEdit,
  onNotice,
  onGoTo,
}: {
  tasks: TaskRow[];
  tripSteps: TripStep[];
  workStreams: WorkStreamRow[];
  wsById: Map<string, string>;
  projById: Map<string, string>;
  onEdit: (t: TaskRow) => void;
  onNotice: (s: string | null) => void;
  onGoTo: (t: Tab) => void;
}) {
  const now = Date.parse(useContext(NowContext));

  // Travel admin does not stand here as five rows per trip. Each trip that
  // still owes a step becomes one line, ranked exactly where its most urgent
  // step would have ranked, naming that step and counting the rest.
  const open = tasks.filter(
    (t) =>
      !t.trip_id &&
      (t.status === "inbox" || t.status === "todo" || t.status === "doing")
  );
  const rollups = useMemo(() => rollUpTrips(tripSteps, now), [tripSteps, now]);
  const ranked: OverviewItem[] = [
    ...open,
    ...rollups.map((r) => ({ ...r, rollup: r })),
  ];
  const bands = triage(ranked, now);
  // B19: counted, not ranked. The Board tab still lists each one.
  const waiting = waitingLine(bands.waiting.length);
  const starved = bands.important.filter((t) => !t.rollup && needsDeadline(t));
  const inboxCount = tasks.filter((t) => !t.trip_id && t.status === "inbox").length;
  // Nobody has rated most of these. The ranking above is only as good as
  // tasks.priority, and while everything sits on the default "medium" the
  // top band is ordering on the clock alone: the very method he named as his
  // problem. One line, one link, no new machinery.
  const unrated = unratedPrompt(open);

  const stats: { label: string; value: number; tone: string; go: Tab }[] = [
    { label: "Do first", value: bands.do_first.length, tone: bands.do_first.length ? "text-overdue" : "", go: "board" },
    { label: "Important", value: bands.important.length, tone: bands.important.length ? "text-accent" : "", go: "board" },
    { label: "Urgent", value: bands.urgent.length, tone: bands.urgent.length ? "text-today" : "", go: "board" },
    { label: "Inbox", value: inboxCount, tone: inboxCount ? "text-accent" : "", go: "inbox" },
  ];

  const perStream = workStreams
    .map((w) => ({
      name: w.name,
      count: open.filter((t) => t.work_stream_id === w.id).length,
    }))
    .filter((s) => s.count > 0);

  const sections: { title: string; hint?: string; items: OverviewItem[] }[] = [
    { title: "Do first", hint: "Urgent and important.", items: bands.do_first },
    {
      title: "Important, not urgent",
      hint: "Starves first when the week gets loud. A missing deadline is the warning sign.",
      items: bands.important,
    },
    { title: "Urgent, less important", items: bands.urgent },
    { title: "Everything else", items: bands.later },
  ];

  return (
    <div>
      <div className="grid grid-cols-2 gap-2">
        {stats.map((s) => (
          <button
            key={s.label}
            onClick={() => onGoTo(s.go)}
            className="press rounded-xl border border-border bg-surface p-3 text-left shadow-[var(--shadow-card)] active:bg-surface-2"
          >
            <p className={"text-2xl font-semibold " + s.tone}>{s.value}</p>
            <div className="flex items-baseline justify-between gap-2">
              <p className="text-xs text-secondary">{s.label}</p>
              <span className="text-[11px] text-muted">View</span>
            </div>
          </button>
        ))}
      </div>

      {unrated && (
        <p className="mt-3 rounded-xl border border-brand/30 bg-brand-soft p-3 text-xs text-secondary">
          {unrated.count} of {unrated.total} open tasks have no priority set by
          anyone, so this ranking is running on due dates alone.{" "}
          <span className="font-medium text-brand-deep">
            Ask Claude to go through them
          </span>{" "}
          (in your Life OS project, say &ldquo;Review my task priorities&rdquo;). It
          proposes one and says why; you can argue with every one.
        </p>
      )}

      {waiting && (
        <p className="mt-3 text-xs text-secondary">
          {waiting} They join this ranking on the day they can start; the{" "}
          <button
            onClick={() => onGoTo("board")}
            className="font-medium text-accent underline-offset-2 hover:underline"
          >
            Board
          </button>{" "}
          lists them now.
        </p>
      )}

      {starved.length > 0 && (
        <p className="mt-3 rounded-xl border border-waiting/30 bg-waiting-soft p-3 text-xs text-waiting">
          {starved.length === 1
            ? "1 important task has no deadline."
            : `${starved.length} important tasks have no deadline.`}{" "}
          Nothing will chase {starved.length === 1 ? "it" : "them"}: open{" "}
          {starved.length === 1 ? "it" : "each one"} and set a date, and the
          reminder machinery treats it like a real one.
        </p>
      )}

      {sections.map((s) =>
        s.items.length === 0 ? null : (
          <section key={s.title} className="mt-5">
            <div className="mb-2">
              <BandHead title={s.title} count={s.items.length} />
              {s.hint && <p className="mt-1.5 text-[11px] text-muted">{s.hint}</p>}
            </div>
            <div className="space-y-2">
              {s.items.map((t) =>
                t.rollup ? (
                  <TripRollupItem key={t.id} rollup={t.rollup} />
                ) : (
                  <TaskItem
                    key={t.id}
                    task={t as TaskRow}
                    wsById={wsById}
                    projById={projById}
                    onEdit={onEdit}
                    onNotice={onNotice}
                  />
                )
              )}
            </div>
          </section>
        )
      )}

      {open.length === 0 && (
        <div className="mt-5">
          <Empty title="No open tasks.">
            Capture work with + Task, or ask the assistant to scan your mail.
            New tasks rank themselves here: urgent and important first.
          </Empty>
        </div>
      )}

      {perStream.length > 0 && (
        <section className="mt-6">
          <SectionLabel className="mb-2">Open tasks by work stream</SectionLabel>
          <div className="flex flex-wrap gap-2">
            {perStream.map((s) => (
              <span
                key={s.name}
                className="rounded-full border border-border bg-surface-2 px-3 py-1 text-xs text-secondary"
              >
                {s.name}: {s.count}
              </span>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

function InboxTab({
  tasks,
  workStreams,
  wsById,
  projById,
  onEdit,
  onNotice,
}: {
  tasks: TaskRow[];
  workStreams: WorkStreamRow[];
  wsById: Map<string, string>;
  projById: Map<string, string>;
  onEdit: (t: TaskRow) => void;
  onNotice: (s: string | null) => void;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const inbox = tasks.filter((t) => t.status === "inbox");

  function moveTo(task: TaskRow, status: TaskRow["status"]) {
    startTransition(async () => {
      await setTaskStatusAction(task.id, status);
      router.refresh();
    });
  }

  return (
    <div>
      <QuickAdd workStreams={workStreams} onNotice={onNotice} />
      {inbox.length === 0 ? (
        <div className="mt-4">
          <Empty title="Inbox clear.">
            Quick-added tasks and mail-scan proposals land here first, so
            nothing captured can hide. Sort each one to To do when you see it.
          </Empty>
        </div>
      ) : (
        <div className="mt-3 space-y-2">
          {inbox.map((t) => (
            <TaskItem
              key={t.id}
              task={t}
              wsById={wsById}
              projById={projById}
              onEdit={onEdit}
              onNotice={onNotice}
              extraActions={
                <button
                  onClick={() => moveTo(t, "todo")}
                  disabled={pending}
                  className="press min-h-11 shrink-0 rounded-lg border border-border-strong px-2.5 text-xs font-medium disabled:opacity-50"
                >
                  To do
                </button>
              }
            />
          ))}
        </div>
      )}
    </div>
  );
}

// Which board columns are collapsed: a per-device view choice, so it lives
// in localStorage (like the theme), read through useSyncExternalStore.
const COLLAPSED_KEY = "life_os_board_collapsed";
let collapsedMem: string | null = null;
const collapsedListeners = new Set<() => void>();
function readCollapsed(): string {
  if (collapsedMem === null) {
    try {
      collapsedMem = localStorage.getItem(COLLAPSED_KEY) ?? "";
    } catch {
      collapsedMem = "";
    }
  }
  return collapsedMem;
}
function subscribeCollapsed(cb: () => void) {
  collapsedListeners.add(cb);
  return () => collapsedListeners.delete(cb);
}
function toggleCollapsed(key: string) {
  const set = new Set(readCollapsed().split(",").filter(Boolean));
  if (!set.delete(key)) set.add(key);
  collapsedMem = [...set].join(",");
  try {
    localStorage.setItem(COLLAPSED_KEY, collapsedMem);
  } catch {
    // Private mode: the choice holds until the page reloads.
  }
  collapsedListeners.forEach((cb) => cb());
}

function BoardTab({
  tasks,
  wsById,
  projById,
  onEdit,
  onNotice,
}: {
  tasks: TaskRow[];
  wsById: Map<string, string>;
  projById: Map<string, string>;
  onEdit: (t: TaskRow) => void;
  onNotice: (s: string | null) => void;
}) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  // A drop shows at once and gives way to the server's list when it arrives.
  const [local, setLocal] = useState<{ base: TaskRow[]; rows: TaskRow[] } | null>(null);
  const rows = local && local.base === tasks ? local.rows : tasks;
  const [drag, setDrag] = useState<{ id: string; title: string; x: number; y: number } | null>(null);
  const [target, setTarget] = useState<{ status: BoardStatus; index: number } | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const columns: { key: BoardStatus; label: string; note?: string }[] = [
    {
      key: "inbox",
      label: "Unsorted",
      note: "Captured but not triaged. These are easy to forget, so they lead.",
    },
    { key: "todo", label: "To do" },
    { key: "doing", label: "Doing" },
    { key: "done", label: "Done" },
  ];

  function drop(id: string, status: BoardStatus, index: number) {
    const r = placeCard(rows, id, status, index);
    if (!r) return;
    setLocal({ base: tasks, rows: r.tasks });
    startTransition(async () => {
      const res = await moveTaskOnBoardAction(id, status, r.writes);
      if (!res.ok) {
        onNotice(res.message);
        setLocal(null);
      } else if (res.reminderNote) onNotice(res.reminderNote);
      router.refresh();
    });
  }

  // The column and slot under the pointer, counting cards without the one
  // being dragged.
  function targetAt(x: number, y: number, dragId: string) {
    const col = document.elementFromPoint(x, y)?.closest<HTMLElement>("[data-col]");
    if (!col) return null;
    const cards = Array.from(col.querySelectorAll<HTMLElement>("[data-card]")).filter(
      (c) => c.dataset.card !== dragId
    );
    const index = cards.filter((c) => {
      const b = c.getBoundingClientRect();
      return b.top + b.height / 2 < y;
    }).length;
    return { status: col.dataset.col as BoardStatus, index };
  }

  function stopDrag() {
    setDrag(null);
    setTarget(null);
  }

  // Pointer events cover mouse, touch and pen alike. The grip is touch-none,
  // so dragging it on a phone moves the card instead of scrolling the page.
  function gripHandlers(t: TaskRow) {
    return {
      onPointerDown: (e: React.PointerEvent<HTMLButtonElement>) => {
        e.currentTarget.setPointerCapture(e.pointerId);
        setDrag({ id: t.id, title: t.title, x: e.clientX, y: e.clientY });
        setTarget(targetAt(e.clientX, e.clientY, t.id));
      },
      onPointerMove: (e: React.PointerEvent<HTMLButtonElement>) => {
        if (drag?.id !== t.id) return;
        setDrag({ ...drag, x: e.clientX, y: e.clientY });
        setTarget(targetAt(e.clientX, e.clientY, t.id));
        // Near the board's edge, scroll it so far columns are reachable on a phone.
        const el = scroller.current;
        const box = el?.getBoundingClientRect();
        if (el && box && e.clientX > box.right - 40) el.scrollLeft += 12;
        if (el && box && e.clientX < box.left + 40) el.scrollLeft -= 12;
      },
      onPointerUp: () => {
        if (drag?.id === t.id && target) drop(t.id, target.status, target.index);
        stopDrag();
      },
      onPointerCancel: stopDrag,
      // Keyboard: up and down reorder, left and right change column.
      onKeyDown: (e: React.KeyboardEvent<HTMLButtonElement>) => {
        const status = t.status as BoardStatus;
        const i = columnCards(rows, status).findIndex((c) => c.id === t.id);
        const ci = BOARD_STATUSES.indexOf(status);
        if (e.key === "ArrowUp") drop(t.id, status, i - 1);
        else if (e.key === "ArrowDown") drop(t.id, status, i + 1);
        else if (e.key === "ArrowLeft" && ci > 0) drop(t.id, BOARD_STATUSES[ci - 1], 0);
        else if (e.key === "ArrowRight" && ci < BOARD_STATUSES.length - 1)
          drop(t.id, BOARD_STATUSES[ci + 1], 0);
        else return;
        e.preventDefault();
      },
    };
  }

  const collapsed = new Set(
    useSyncExternalStore(subscribeCollapsed, readCollapsed, () => "").split(",").filter(Boolean)
  );

  const marker = <div className="h-1 rounded-full bg-accent" aria-hidden />;

  return (
    <>
      <div ref={scroller} className="-mx-4 flex snap-x gap-2 overflow-x-auto px-4 pb-3">
        {columns.map((col) => {
          const items = columnCards(rows, col.key);
          const here = target?.status === col.key ? target.index : -1;
          let k = 0;
          const tone = here >= 0 ? "border-accent bg-accent-soft" : "border-border bg-surface-2";
          // Collapsed: a thin strip that still takes a dropped card (on top).
          if (collapsed.has(col.key))
            return (
              <section
                key={col.key}
                data-col={col.key}
                className={"w-9 shrink-0 rounded-xl border " + tone}
              >
                <button
                  onClick={() => toggleCollapsed(col.key)}
                  aria-expanded={false}
                  aria-label={`Show ${col.label}, ${items.length} tasks`}
                  className="press flex h-full min-h-48 w-full flex-col items-center gap-2 py-3 text-sm font-medium text-neutral-500"
                >
                  <span aria-hidden>&rsaquo;</span>
                  <span className="[writing-mode:vertical-rl]">
                    {col.label} ({items.length})
                  </span>
                </button>
              </section>
            );
          return (
            <section
              key={col.key}
              data-col={col.key}
              className={"min-w-52 flex-1 snap-start rounded-xl border p-1.5 " + tone}
            >
              <h3>
                <button
                  onClick={() => toggleCollapsed(col.key)}
                  aria-expanded
                  title="Collapse this column"
                  className="press flex min-h-9 w-full items-center gap-1.5 rounded-lg px-1 text-left text-sm font-medium text-neutral-500"
                >
                  <span aria-hidden>&lsaquo;</span>
                  {col.label} ({items.length})
                </button>
              </h3>
              {col.note && items.length > 0 && (
                <p className="mb-2 px-1 text-xs text-neutral-400">{col.note}</p>
              )}
              {(!col.note || items.length === 0) && <div className="mb-2" />}
              <div className="min-h-16 space-y-2">
                {items.map((t) => {
                  const dragged = drag?.id === t.id;
                  const showMarker = !dragged && k === here;
                  if (!dragged) k++;
                  return (
                    <div key={t.id}>
                      {showMarker && <div className="mb-2">{marker}</div>}
                      <div data-card={t.id} className={dragged ? "opacity-40" : ""}>
                        <TaskItem
                          task={t}
                          wsById={wsById}
                          projById={projById}
                          onEdit={onEdit}
                          onNotice={onNotice}
                          wrapTitle
                          extraActions={
                            <button
                              {...gripHandlers(t)}
                              aria-label={`Move ${t.title}. Arrow keys move it up, down or to another column.`}
                              title="Drag to move"
                              className="flex h-11 w-7 shrink-0 cursor-grab touch-none items-center justify-center rounded text-neutral-400 hover:text-secondary active:cursor-grabbing"
                            >
                              <svg width="10" height="16" viewBox="0 0 10 16" fill="currentColor" aria-hidden>
                                <circle cx="2" cy="2" r="1.5" />
                                <circle cx="8" cy="2" r="1.5" />
                                <circle cx="2" cy="8" r="1.5" />
                                <circle cx="8" cy="8" r="1.5" />
                                <circle cx="2" cy="14" r="1.5" />
                                <circle cx="8" cy="14" r="1.5" />
                              </svg>
                            </button>
                          }
                        />
                      </div>
                    </div>
                  );
                })}
                {here >= 0 && here >= k && marker}
                {items.length === 0 && here < 0 && (
                  <p className="px-1 text-xs text-neutral-400">Nothing here.</p>
                )}
              </div>
            </section>
          );
        })}
      </div>
      {drag && (
        <div
          className="pointer-events-none fixed z-50 max-w-60 truncate rounded-lg border border-accent bg-surface px-3 py-2 text-sm shadow-lg"
          style={{ left: drag.x + 8, top: drag.y + 8 }}
        >
          {drag.title}
        </div>
      )}
    </>
  );
}


function ProjectsTab({
  tasks,
  projects,
  workStreams,
  wsById,
  onEdit,
  onNotice,
}: {
  tasks: TaskRow[];
  projects: ProjectRow[];
  workStreams: WorkStreamRow[];
  wsById: Map<string, string>;
  onEdit: (t: TaskRow) => void;
  onNotice: (s: string | null) => void;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [selected, setSelected] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const [wsId, setWsId] = useState(workStreams[0]?.id ?? "");
  // Two-step delete: holds the id of the project armed for deletion.
  const [armedId, setArmedId] = useState<string | null>(null);

  function addProject() {
    if (!name.trim() || !wsId) return;
    startTransition(async () => {
      const r = await createProjectAction({ name, work_stream_id: wsId });
      if (!r.ok) onNotice(r.message ?? "Could not add project.");
      setName("");
      setAdding(false);
      router.refresh();
    });
  }
  function setStatus(id: string, status: ProjectRow["status"]) {
    startTransition(async () => {
      await updateProjectAction(id, { status });
      router.refresh();
    });
  }
  function removeProject(id: string) {
    if (armedId !== id) {
      setArmedId(id);
      return;
    }
    setArmedId(null);
    startTransition(async () => {
      await deleteProjectAction(id);
      if (selected === id) setSelected(null);
      router.refresh();
    });
  }

  if (selected) {
    const project = projects.find((p) => p.id === selected);
    const items = tasks.filter((t) => t.project_id === selected);
    return (
      <div>
        <button
          onClick={() => setSelected(null)}
          className="text-xs font-medium text-muted"
        >
          ‹ All projects
        </button>
        <h2 className="mt-2 text-lg font-medium">{project?.name}</h2>
        <p className="text-xs text-neutral-500">
          {wsById.get(project?.work_stream_id ?? "")} · {project?.status}
        </p>
        <div className="mt-3 space-y-2">
          {items.length === 0 ? (
            <p className="text-sm text-neutral-400">No tasks in this project.</p>
          ) : (
            items.map((t) => (
              <TaskItem
                key={t.id}
                task={t}
                wsById={wsById}
                projById={new Map(projects.map((p) => [p.id, p.name]))}
                onEdit={onEdit}
                onNotice={onNotice}
              />
            ))
          )}
        </div>
      </div>
    );
  }

  return (
    <div>
      <button
        onClick={() => setAdding((v) => !v)}
        className="rounded-lg border border-border-strong px-3 py-1.5 text-sm"
      >
        + Project
      </button>
      {adding && (
        <div className="mt-2 space-y-2 rounded-lg border border-border p-3">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Project name"
            className={inputCls}
          />
          <select value={wsId} onChange={(e) => setWsId(e.target.value)} className={inputCls}>
            {workStreams.map((w) => (
              <option key={w.id} value={w.id}>
                {w.name}
              </option>
            ))}
          </select>
          <button
            onClick={addProject}
            disabled={pending}
            className="press min-h-11 rounded-lg bg-accent px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50 dark:text-neutral-950"
          >
            Add
          </button>
        </div>
      )}
      <div className="mt-3 space-y-2">
        {projects.length === 0 ? (
          <Empty>No projects yet. Use + Project to group related tasks.</Empty>
        ) : (
          projects.map((p) => {
            const count = tasks.filter((t) => t.project_id === p.id).length;
            return (
              <div
                key={p.id}
                className="flex items-center justify-between rounded-lg border border-border bg-surface p-2 shadow-[var(--shadow-card)]"
              >
                <button
                  onClick={() => {
                    setArmedId(null);
                    setSelected(p.id);
                  }}
                  className="text-left"
                >
                  <p className="text-sm font-medium">{p.name}</p>
                  <p className="text-[11px] text-neutral-500">
                    {wsById.get(p.work_stream_id)} · {count} task{count === 1 ? "" : "s"}
                  </p>
                </button>
                <div className="flex items-center gap-1">
                  <select
                    value={p.status}
                    onChange={(e) => setStatus(p.id, e.target.value as ProjectRow["status"])}
                    className="rounded border border-border-strong bg-surface px-1 py-0.5 text-[11px]"
                  >
                    <option value="active">active</option>
                    <option value="on_hold">on hold</option>
                    <option value="done">done</option>
                    <option value="dropped">dropped</option>
                  </select>
                  <button
                    onClick={() => removeProject(p.id)}
                    className={
                      armedId === p.id
                        ? "rounded bg-red-600 px-1.5 py-0.5 text-[11px] font-medium text-white"
                        : "text-[11px] text-overdue"
                    }
                  >
                    {armedId === p.id ? "Confirm delete" : "Delete"}
                  </button>
                </div>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}

function QuickAdd({
  workStreams,
  onNotice,
}: {
  workStreams: WorkStreamRow[];
  onNotice: (s: string | null) => void;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [title, setTitle] = useState("");
  const [wsId, setWsId] = useState(workStreams[0]?.id ?? "");

  function add() {
    if (!title.trim() || !wsId) return;
    startTransition(async () => {
      const r = await quickAddTaskAction(title.trim(), wsId);
      if (!r.ok) onNotice(r.message);
      setTitle("");
      router.refresh();
    });
  }
  return (
    <div className="flex gap-2">
      <input
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && add()}
        placeholder="Quick add to inbox"
        className={inputCls}
      />
      <select
        value={wsId}
        onChange={(e) => setWsId(e.target.value)}
        className="w-32 shrink-0 rounded-lg border border-border-strong bg-surface px-2 py-2 text-sm"
      >
        {workStreams.map((w) => (
          <option key={w.id} value={w.id}>
            {w.name}
          </option>
        ))}
      </select>
      <button
        onClick={add}
        disabled={pending}
        className="press min-h-11 shrink-0 rounded-lg bg-accent px-3 text-sm font-medium text-white disabled:opacity-50 dark:text-neutral-950"
      >
        Add
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
interface FormFields {
  title: string;
  notes: string;
  status: TaskRow["status"];
  priority: TaskRow["priority"];
  workStreamId: string;
  projectId: string;
  hasDue: boolean;
  dueDate: string;
  dueTime: string;
  recurFreq: "" | "daily" | "weekly" | "monthly" | "yearly";
  recurInterval: string;
  // B30: follow the stream, billable, or not billable.
  billableChoice: "follow" | "yes" | "no";
  // B32. As typed: 1.5 or 1:30. Blank means not logged.
  hoursSpent: string;
  offsets: number[];
  onCalendar: boolean;
  // YYYY-MM-DD from the date input, or "" for "can start now".
  notBefore: string;
  // B26. Blank means no instruction.
  agentInstructions: string;
}

function taskToFields(t: TaskRow | null, workStreams: WorkStreamRow[]): FormFields {
  // priority_source and priority_reason are deliberately NOT form fields.
  // Saving a changed priority here records it as his and clears the reason,
  // decided server-side in lib/tasks/write.ts. Nothing on this screen can
  // write priority_source directly.
  const rec = (t?.recurring_rule ?? "").split(":");
  return {
    title: t?.title ?? "",
    notes: t?.notes ?? "",
    status: t?.status ?? "todo",
    priority: t?.priority ?? "medium",
    workStreamId: t?.work_stream_id ?? workStreams[0]?.id ?? "",
    projectId: t?.project_id ?? "",
    hasDue: !!t?.due_ts,
    dueDate: t?.due_ts ? istDayKey(t.due_ts) : "",
    dueTime: t?.due_ts ? hmFromIso(t.due_ts) : "09:00",
    recurFreq: (rec[0] as FormFields["recurFreq"]) || "",
    recurInterval: rec[1] ?? "1",
    billableChoice: t?.billable === true ? "yes" : t?.billable === false ? "no" : "follow",
    hoursSpent: t?.hours_spent != null ? formatHours(t.hours_spent) : "",
    offsets: t?.remind_offsets ?? [7, 3, 1, 0],
    // A new task interrupts him on the calendar unless he says otherwise,
    // which is what every task did before M7a.
    onCalendar: (t?.reminder_mode ?? "calendar") === "calendar",
    notBefore: t?.not_before ?? "",
    agentInstructions: t?.agent_instructions ?? "",
  };
}

// B30. Where a finished task's billing stands, with his own marks. They act at
// once (not on Save), each is audited, and the last one can be undone here.
// No amounts: Life OS records state and a reference, nothing more.
function BillingBox({ task }: { task: TaskRow }) {
  const router = useRouter();
  const [state, setState] = useState<BillingState | null>((task.billing_state as BillingState | null) ?? null);
  const [ref, setRef] = useState(task.billing_ref ?? "");
  const [asking, setAsking] = useState(false);
  const [prev, setPrev] = useState<{ state: BillingState | null; ref: string | null } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function mark(next: BillingState | null, refValue: string | null) {
    setErr(null);
    startTransition(async () => {
      const r = await setBillingStateAction(task.id, next, refValue);
      if (!r.ok) {
        setErr(r.message);
        return;
      }
      setPrev({ state: r.prev_state, ref: r.prev_ref });
      setState(next);
      setRef(next ? (refValue ?? "") : "");
      setAsking(false);
      router.refresh();
    });
  }

  function undo() {
    if (!prev) return;
    const p = prev;
    setErr(null);
    startTransition(async () => {
      const r = await setBillingStateAction(task.id, p.state, p.ref);
      if (!r.ok) {
        setErr(r.message);
        return;
      }
      setState(p.state);
      setRef(p.ref ?? "");
      setPrev(null);
      router.refresh();
    });
  }

  const label =
    state === "invoiced"
      ? `Invoiced${ref ? `, ref ${ref}` : ""}`
      : state === "estimate_drafted"
        ? `Estimate drafted${ref ? `, ref ${ref}` : ""}`
        : state === "not_billable"
          ? "Not billable this time"
          : "Not marked yet";
  return (
    <div className="rounded-lg border border-border bg-surface p-2.5">
      <p className="text-xs font-semibold text-foreground">Billing: {label}</p>
      {asking ? (
        <div className="mt-2 space-y-2">
          <input
            value={ref}
            maxLength={REF_MAX}
            onChange={(e) => setRef(e.target.value)}
            placeholder="Zoho invoice number (optional)"
            className={inputCls}
          />
          <div className="flex gap-2">
            <button onClick={() => mark("invoiced", ref)} disabled={pending} className={btnPrimary}>
              {pending ? "Saving" : "Mark invoiced"}
            </button>
            <button
              onClick={() => setAsking(false)}
              disabled={pending}
              className="press min-h-11 rounded-lg border border-border-strong px-3 text-sm font-medium disabled:opacity-50"
            >
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <div className="mt-2 flex flex-wrap gap-2">
          {state !== "invoiced" && (
            <button
              onClick={() => setAsking(true)}
              disabled={pending}
              className="press min-h-11 rounded-lg border border-border-strong px-3 text-sm font-medium disabled:opacity-50"
            >
              Invoiced
            </button>
          )}
          {state !== "not_billable" && (
            <button
              onClick={() => mark("not_billable", null)}
              disabled={pending}
              className="press min-h-11 rounded-lg border border-border-strong px-3 text-sm font-medium disabled:opacity-50"
            >
              Not billable this time
            </button>
          )}
          {state !== null && (
            <button
              onClick={() => mark(null, null)}
              disabled={pending}
              className="press min-h-11 rounded-lg border border-border-strong px-3 text-sm font-medium disabled:opacity-50"
            >
              Reopen
            </button>
          )}
          {prev && (
            <button onClick={undo} disabled={pending} className="press min-h-11 px-3 text-sm font-medium text-accent">
              Undo
            </button>
          )}
        </div>
      )}
      {err && <p className="mt-1 text-sm text-overdue">{err}</p>}
    </div>
  );
}

function TaskForm({
  task,
  projects,
  workStreams,
  onClose,
  onNotice,
}: {
  task: TaskRow | null;
  projects: ProjectRow[];
  workStreams: WorkStreamRow[];
  onClose: () => void;
  onNotice: (s: string | null) => void;
}) {
  const router = useRouter();
  const [f, setF] = useState<FormFields>(() => taskToFields(task, workStreams));
  const [pending, startTransition] = useTransition();
  const [err, setErr] = useState<string | null>(null);
  const [armed, setArmed] = useState(false);
  const isEdit = !!task;
  const streamProjects = projects.filter((p) => p.work_stream_id === f.workStreamId);

  function buildInput(): TaskInput {
    let due_ts: string | null = null;
    if (f.hasDue && f.dueDate) {
      const [y, m, d] = f.dueDate.split("-").map(Number);
      const [hh, mm] = f.dueTime.split(":").map(Number);
      due_ts = istInstant({ y, m, d }, hh || 0, mm || 0).toISOString();
    }
    const recurring_rule = f.recurFreq
      ? `${f.recurFreq}:${Math.max(1, parseInt(f.recurInterval || "1", 10))}`
      : null;
    const offsets = [...f.offsets].sort((a, b) => b - a);
    return {
      title: f.title,
      notes: f.notes || null,
      status: f.status,
      priority: f.priority,
      due_ts,
      work_stream_id: f.workStreamId,
      project_id: f.projectId || null,
      recurring_rule,
      // B30: the three-way choice (the older is_billable column is unused).
      billable: f.billableChoice === "follow" ? null : f.billableChoice === "yes",
      remind_offsets: offsets.length ? offsets : [7, 3, 1, 0],
      reminder_mode: f.onCalendar ? "calendar" : "in_app",
      not_before: f.notBefore || null,
      // B26. Blank becomes null. Resending the text he opened the drawer
      // with changes nothing in the database (the guard compares the text).
      agent_instructions: f.agentInstructions.trim() ? f.agentInstructions : null,
    };
  }

  function submit() {
    setErr(null);
    setArmed(false);
    const input = buildInput();
    if (!input.title.trim()) {
      setErr("A title is required.");
      return;
    }
    const hrs = parseHours(f.hoursSpent);
    if (!hrs.ok) {
      setErr(hrs.message);
      return;
    }
    input.hours_spent = hrs.value;
    startTransition(async () => {
      const r = isEdit
        ? await updateTaskAction(task!.id, input)
        : await createTaskAction(input);
      if (r.ok) {
        if (r.reminderNote) onNotice(r.reminderNote);
        onClose();
        router.refresh();
      } else {
        setErr(r.message);
      }
    });
  }

  function remove() {
    if (!task) return;
    if (!armed) {
      setArmed(true);
      return;
    }
    startTransition(async () => {
      await deleteTaskAction(task.id);
      onClose();
      router.refresh();
    });
  }

  return (
    <Drawer title={isEdit ? "Edit task" : "New task"} onClose={onClose}>
      <div className="space-y-3">
        <Field label="Title">
          <input value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} className={inputCls} />
        </Field>
        <div className="flex gap-2">
          <Field label="Work stream">
            <select
              value={f.workStreamId}
              onChange={(e) => setF({ ...f, workStreamId: e.target.value, projectId: "" })}
              className={inputCls}
            >
              {workStreams.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Project">
            <select
              value={f.projectId}
              onChange={(e) => setF({ ...f, projectId: e.target.value })}
              className={inputCls}
            >
              <option value="">None</option>
              {streamProjects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </Field>
        </div>
        <Field label="Status">
          <div className="flex flex-wrap gap-1.5">
            {(
              [
                ["inbox", "Inbox"],
                ["todo", "To do"],
                ["doing", "Doing"],
                ["done", "Done"],
                ["dropped", "Dropped"],
              ] as [TaskRow["status"], string][]
            ).map(([value, label]) => (
              <button
                key={value}
                type="button"
                onClick={() => setF({ ...f, status: value })}
                className={
                  "rounded-full border px-3 py-1.5 text-sm " +
                  (f.status === value
                    ? value === "done"
                      ? "border-green-600 bg-green-600 text-neutral-950"
                      : value === "dropped"
                        ? "border-neutral-500 bg-neutral-500 text-white"
                        : "border-accent bg-accent text-white dark:text-neutral-950"
                    : "border-border-strong text-secondary")
                }
              >
                {label}
              </button>
            ))}
          </div>
          {f.recurFreq && f.status === "done" && (
            <p className="mt-1 text-xs text-neutral-500">
              Done removes this reminder from the calendar and schedules the next
              occurrence.
            </p>
          )}
          {f.recurFreq && f.status === "dropped" && (
            <p className="mt-1 text-xs text-neutral-500">
              Dropped removes the reminder and ends the series. No next occurrence.
            </p>
          )}
        </Field>
        <Field label="Priority">
          <select
            value={f.priority}
            onChange={(e) => setF({ ...f, priority: e.target.value as TaskRow["priority"] })}
            className={inputCls}
          >
            <option value="low">Low</option>
            <option value="medium">Medium</option>
            <option value="high">High</option>
          </select>
          {task?.priority_source === "assistant" && task.priority_reason && (
            <div className="mt-1.5">
              <PriorityReason
                reason={task.priority_reason}
                source={task.priority_source}
              />
              <p className="mt-0.5 text-[11px] text-muted">
                Change it and it becomes yours: this reason goes, and nothing
                the assistant does will move it again.
              </p>
            </div>
          )}
        </Field>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={f.hasDue}
            onChange={(e) => setF({ ...f, hasDue: e.target.checked })}
          />
          Has a due date
        </label>
        {f.hasDue && (
          <>
            <div className="flex gap-2">
              <Field label="Due date">
                <input
                  type="date"
                  value={f.dueDate}
                  onChange={(e) => setF({ ...f, dueDate: e.target.value })}
                  className={inputCls}
                />
              </Field>
              <Field label="Time">
                <input
                  type="time"
                  value={f.dueTime}
                  onChange={(e) => setF({ ...f, dueTime: e.target.value })}
                  className={inputCls}
                />
              </Field>
            </div>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={f.onCalendar}
                onChange={(e) => setF({ ...f, onCalendar: e.target.checked })}
              />
              Remind me on the calendar
            </label>
            <p className="-mt-1 text-xs text-secondary">
              {f.onCalendar
                ? "This one interrupts you on your phone on the days below."
                : "Otherwise it stays in the app and on your morning brief."}
            </p>
            {f.onCalendar && (
              <Field label="Remind, days before due">
                <RemindChips value={f.offsets} onChange={(v) => setF({ ...f, offsets: v })} />
              </Field>
            )}
          </>
        )}
        <Field label="Can start from">
          <input
            type="date"
            value={f.notBefore}
            onChange={(e) => setF({ ...f, notBefore: e.target.value })}
            className={inputCls}
          />
        </Field>
        <p className="-mt-1 text-xs text-secondary">
          Optional. Until this date it stays off Home and the morning brief and
          is never urgent. Leave it empty when you can start now.
        </p>
        <div className="flex gap-2">
          <Field label="Repeats">
            <select
              value={f.recurFreq}
              onChange={(e) => setF({ ...f, recurFreq: e.target.value as FormFields["recurFreq"] })}
              className={inputCls}
            >
              <option value="">No</option>
              <option value="daily">Daily</option>
              <option value="weekly">Weekly</option>
              <option value="monthly">Monthly</option>
              <option value="yearly">Yearly</option>
            </select>
          </Field>
          {f.recurFreq && (
            <Field label="Every (interval)">
              <input
                type="number"
                min={1}
                value={f.recurInterval}
                onChange={(e) => setF({ ...f, recurInterval: e.target.value })}
                className={inputCls}
              />
            </Field>
          )}
        </div>
        <Field label="Billable">
          <select
            value={f.billableChoice}
            onChange={(e) => setF({ ...f, billableChoice: e.target.value as FormFields["billableChoice"] })}
            className={inputCls}
          >
            <option value="follow">Follow stream</option>
            <option value="yes">Billable</option>
            <option value="no">Not billable</option>
          </select>
        </Field>
        <Field label="Hours spent">
          <input
            value={f.hoursSpent}
            onChange={(e) => setF({ ...f, hoursSpent: e.target.value })}
            inputMode="decimal"
            step={0.25}
            placeholder="1.5 or 1:30"
            className={inputCls}
          />
        </Field>
        {f.status === "done" && f.hoursSpent.trim() === "" && (
          <p className="-mt-1 text-xs text-secondary">Hours spent? Optional: skip it and save as usual.</p>
        )}
        {task && task.status === "done" && <BillingBox task={task} />}
        <Field label="Notes">
          <textarea
            value={f.notes}
            onChange={(e) => setF({ ...f, notes: e.target.value })}
            className={inputCls}
            rows={2}
          />
        </Field>

        <Field label="Instructions for agents">
          <textarea
            value={f.agentInstructions}
            onChange={(e) => setF({ ...f, agentInstructions: e.target.value.slice(0, INSTRUCTION_MAX) })}
            maxLength={INSTRUCTION_MAX}
            className={inputCls}
            rows={3}
            placeholder="What should your agents do on this task? They pick it up on the next sweep."
          />
        </Field>
        <p className="-mt-1 text-right text-[11px] text-secondary">
          {f.agentInstructions.length} / {INSTRUCTION_MAX}
        </p>
        {task && (agentStatusLine(task, resultWhen(task)) || task.agent_result) && (
          <div className="rounded-lg border border-border bg-surface p-2.5">
            <p className="text-xs font-semibold text-foreground">
              {agentStatusLine(task, resultWhen(task)) ?? "Last result"}
            </p>
            {task.agent_result && (
              <>
                <p className="mt-1 whitespace-pre-wrap text-xs text-secondary">{task.agent_result}</p>
                {task.agent_result_at && (
                  <p className="mt-1 text-[11px] text-muted">
                    Written {formatDateShortIST(task.agent_result_at)}, {formatTimeIST(task.agent_result_at)}
                  </p>
                )}
              </>
            )}
          </div>
        )}

        {err && <p className="text-sm text-overdue">{err}</p>}
        <div className={drawerFooterCls + " flex gap-2"}>
          <button
            onClick={submit}
            disabled={pending}
            className="press min-h-11 flex-1 rounded-lg bg-accent px-3 py-2 text-sm font-medium text-white disabled:opacity-50 dark:text-neutral-950"
          >
            {pending ? "Saving" : isEdit ? "Save" : "Create"}
          </button>
          {isEdit && (
            <button
              onClick={remove}
              disabled={pending}
              className={
                armed
                  ? "rounded-lg bg-red-600 px-3 py-2 text-sm font-medium text-white disabled:opacity-50"
                  : "rounded-lg border border-border-strong px-3 py-2 text-sm text-overdue disabled:opacity-50"
              }
            >
              {armed ? "Confirm delete" : "Delete"}
            </button>
          )}
        </div>
      </div>
    </Drawer>
  );
}

// "29 Sept, 12:40 pm", the time an agent result was written.
function resultWhen(t: TaskRow): string | null {
  return t.agent_result_at
    ? `${formatDateShortIST(t.agent_result_at)}, ${formatTimeIST(t.agent_result_at)}`
    : null;
}

function hmFromIso(iso: string): string {
  const t = formatTimeIST(iso);
  const m = t.match(/(\d+):(\d+)\s*(am|pm)/i);
  if (!m) return "09:00";
  let h = parseInt(m[1], 10) % 12;
  if (/pm/i.test(m[3])) h += 12;
  return `${String(h).padStart(2, "0")}:${m[2]}`;
}
