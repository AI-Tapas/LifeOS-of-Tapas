"use client";

import { createContext, useContext, useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  BandHead,
  Drawer,
  DueBadge,
  Empty,
  Field,
  PageHeader,
  RemindChips,
  SectionLabel,
  btnPrimary,
  drawerFooterCls,
  inputCls,
} from "@/components/ui";
import { formatDateIST, formatTimeIST, istInstant, istDayKey } from "@/lib/datetime";
import { triage, needsDeadline } from "@/lib/tasks/triage";
import {
  createTaskAction,
  updateTaskAction,
  setTaskStatusAction,
  deleteTaskAction,
  quickAddTaskAction,
  createProjectAction,
  updateProjectAction,
  deleteProjectAction,
} from "@/app/(app)/tasks/actions";
import type { TaskInput } from "@/lib/tasks/write";

export interface TaskRow {
  id: string;
  title: string;
  notes: string | null;
  status: "inbox" | "todo" | "doing" | "done" | "dropped";
  priority: "low" | "medium" | "high";
  due_ts: string | null;
  work_stream_id: string;
  project_id: string | null;
  recurring_rule: string | null;
  is_billable: boolean;
  remind_offsets: number[];
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
  board: "Everything you are working through: unsorted, to do, doing, done.",
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
  projects: ProjectRow[];
  workStreams: WorkStreamRow[];
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

function TasksBody({ tasks, projects, workStreams }: TasksViewProps) {
  const [tab, setTab] = useState<Tab>("overview");
  const [editing, setEditing] = useState<TaskRow | "new" | null>(null);
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

      {notice && (
        <p className="mt-3 rounded-lg border border-today/30 bg-today-soft p-2 text-xs text-today">
          {notice}
        </p>
      )}

      <div className="mt-4">
        {tab === "overview" && (
          <OverviewTab
            tasks={tasks}
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
}: {
  task: TaskRow;
  wsById: Map<string, string>;
  projById: Map<string, string>;
  onEdit: (t: TaskRow) => void;
  onNotice: (s: string | null) => void;
  extraActions?: React.ReactNode;
}) {
  const router = useRouter();
  const nowIso = useContext(NowContext);
  const [pending, startTransition] = useTransition();

  function complete() {
    startTransition(async () => {
      const r = await setTaskStatusAction(task.id, "done");
      if (r.ok && r.reminderNote) onNotice(r.reminderNote);
      else if (!r.ok) onNotice(r.message);
      router.refresh();
    });
  }

  const done = task.status === "done";
  return (
    <div className="flex items-center gap-1 rounded-lg border border-border bg-surface p-1.5 shadow-[var(--shadow-card)]">
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
      <button onClick={() => onEdit(task)} className="min-w-0 flex-1 py-1.5 text-left">
        <div className="flex items-center gap-2">
          <span
            className="inline-block h-2 w-2 shrink-0 rounded-full"
            style={{ backgroundColor: PRIORITY_DOT[task.priority] }}
            title={`${task.priority} priority`}
          />
          <span className={"truncate text-sm " + (done ? "line-through text-neutral-400" : "")}>
            {task.title}
          </span>
          <span className="ml-auto pl-1">
            <DueBadge
              dueTs={task.due_ts}
              nowIso={nowIso}
              flagMissing={task.priority === "high" && !done}
            />
          </span>
        </div>
        <div className="mt-0.5 flex flex-wrap gap-x-2 text-[11px] text-neutral-500">
          <span>{wsById.get(task.work_stream_id) ?? "No stream"}</span>
          {task.project_id && <span>{projById.get(task.project_id)}</span>}
          {task.due_ts && (
            <span>
              due {formatDateIST(task.due_ts)}, {formatTimeIST(task.due_ts)}
            </span>
          )}
          {task.recurring_rule && <span>repeats {task.recurring_rule}</span>}
          {task.is_billable && <span>billable</span>}
        </div>
      </button>
      {extraActions}
    </div>
  );
}

function OverviewTab({
  tasks,
  workStreams,
  wsById,
  projById,
  onEdit,
  onNotice,
  onGoTo,
}: {
  tasks: TaskRow[];
  workStreams: WorkStreamRow[];
  wsById: Map<string, string>;
  projById: Map<string, string>;
  onEdit: (t: TaskRow) => void;
  onNotice: (s: string | null) => void;
  onGoTo: (t: Tab) => void;
}) {
  const now = Date.parse(useContext(NowContext));

  const open = tasks.filter(
    (t) => t.status === "inbox" || t.status === "todo" || t.status === "doing"
  );
  const bands = triage(open, now);
  const starved = bands.important.filter((t) => needsDeadline(t));
  const inboxCount = tasks.filter((t) => t.status === "inbox").length;

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

  const sections: { title: string; hint?: string; items: TaskRow[] }[] = [
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
              {s.items.map((t) => (
                <TaskItem
                  key={t.id}
                  task={t}
                  wsById={wsById}
                  projById={projById}
                  onEdit={onEdit}
                  onNotice={onNotice}
                />
              ))}
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
  const [pending, startTransition] = useTransition();
  const columns: { key: TaskRow["status"]; label: string; note?: string }[] = [
    {
      key: "inbox",
      label: "Unsorted",
      note: "Captured but not triaged. These are easy to forget, so they lead.",
    },
    { key: "todo", label: "To do" },
    { key: "doing", label: "Doing" },
    { key: "done", label: "Done" },
  ];
  function move(task: TaskRow, status: TaskRow["status"]) {
    startTransition(async () => {
      const r = await setTaskStatusAction(task.id, status);
      if (r.ok && r.reminderNote) onNotice(r.reminderNote);
      router.refresh();
    });
  }

  return (
    <div className="space-y-5">
      {columns.map((col) => {
        const items = tasks.filter((t) => t.status === col.key);
        return (
          <section key={col.key}>
            <h3 className="text-sm font-medium text-neutral-500">
              {col.label} ({items.length})
            </h3>
            {col.note && items.length > 0 && (
              <p className="mb-2 text-xs text-neutral-400">{col.note}</p>
            )}
            {(!col.note || items.length === 0) && <div className="mb-2" />}
            {items.length === 0 ? (
              <p className="text-xs text-neutral-400">Nothing here.</p>
            ) : (
              <div className="space-y-2">
                {items.map((t) => (
                  <TaskItem
                    key={t.id}
                    task={t}
                    wsById={wsById}
                    projById={projById}
                    onEdit={onEdit}
                    onNotice={onNotice}
                    extraActions={
                      <div className="flex shrink-0 flex-col gap-1">
                        {col.key !== "todo" && col.key !== "inbox" && (
                          <button
                            onClick={() => move(t, col.key === "done" ? "doing" : "todo")}
                            disabled={pending}
                            className="press min-h-11 rounded-lg border border-border-strong px-2.5 text-xs font-medium disabled:opacity-50"
                          >
                            Back
                          </button>
                        )}
                        {col.key !== "done" && (
                          <button
                            onClick={() =>
                              move(
                                t,
                                col.key === "inbox"
                                  ? "todo"
                                  : col.key === "todo"
                                    ? "doing"
                                    : "done"
                              )
                            }
                            disabled={pending}
                            className="press min-h-11 rounded-lg border border-border-strong px-2.5 text-xs font-medium disabled:opacity-50"
                          >
                            {col.key === "inbox" ? "To do" : col.key === "todo" ? "Start" : "Done"}
                          </button>
                        )}
                      </div>
                    }
                  />
                ))}
              </div>
            )}
          </section>
        );
      })}
    </div>
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
  isBillable: boolean;
  offsets: number[];
}

function taskToFields(t: TaskRow | null, workStreams: WorkStreamRow[]): FormFields {
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
    isBillable: t?.is_billable ?? false,
    offsets: t?.remind_offsets ?? [7, 3, 1, 0],
  };
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
      is_billable: f.isBillable,
      remind_offsets: offsets.length ? offsets : [7, 3, 1, 0],
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
        </Field>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={f.hasDue}
            onChange={(e) => setF({ ...f, hasDue: e.target.checked })}
          />
          Has a due date (sets a Google Calendar reminder)
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
            <Field label="Remind, days before due">
              <RemindChips value={f.offsets} onChange={(v) => setF({ ...f, offsets: v })} />
            </Field>
          </>
        )}
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
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={f.isBillable}
            onChange={(e) => setF({ ...f, isBillable: e.target.checked })}
          />
          Billable
        </label>
        <Field label="Notes">
          <textarea
            value={f.notes}
            onChange={(e) => setF({ ...f, notes: e.target.value })}
            className={inputCls}
            rows={2}
          />
        </Field>

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

function hmFromIso(iso: string): string {
  const t = formatTimeIST(iso);
  const m = t.match(/(\d+):(\d+)\s*(am|pm)/i);
  if (!m) return "09:00";
  let h = parseInt(m[1], 10) % 12;
  if (/pm/i.test(m[3])) h += 12;
  return `${String(h).padStart(2, "0")}:${m[2]}`;
}
