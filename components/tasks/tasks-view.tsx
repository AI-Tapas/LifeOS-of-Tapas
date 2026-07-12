"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Drawer, Field, inputCls } from "@/components/ui";
import { formatDateIST, formatTimeIST, istInstant, istDayKey } from "@/lib/datetime";
import {
  createTaskAction,
  updateTaskAction,
  setTaskStatusAction,
  deleteTaskAction,
  quickAddTaskAction,
  createProjectAction,
  updateProjectAction,
  deleteProjectAction,
  type TaskInput,
} from "@/app/(app)/tasks/actions";

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

type Tab = "inbox" | "board" | "projects";

const PRIORITY_DOT: Record<TaskRow["priority"], string> = {
  low: "#94a3b8",
  medium: "#eab308",
  high: "#dc2626",
};

export default function TasksView({
  tasks,
  projects,
  workStreams,
}: {
  tasks: TaskRow[];
  projects: ProjectRow[];
  workStreams: WorkStreamRow[];
}) {
  const [tab, setTab] = useState<Tab>("inbox");
  const [editing, setEditing] = useState<TaskRow | "new" | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const wsById = useMemo(
    () => new Map(workStreams.map((w) => [w.id, w.name])),
    [workStreams]
  );
  const projById = useMemo(() => new Map(projects.map((p) => [p.id, p.name])), [projects]);

  return (
    <div>
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Tasks</h1>
        <button
          onClick={() => setEditing("new")}
          className="rounded-lg bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white"
        >
          + Task
        </button>
      </div>

      <div className="mt-3 flex gap-1">
        {(["inbox", "board", "projects"] as Tab[]).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={
              "rounded-full px-3 py-1 text-sm capitalize " +
              (t === tab
                ? "bg-indigo-600 text-white"
                : "border border-neutral-300 dark:border-neutral-700")
            }
          >
            {t}
          </button>
        ))}
      </div>

      {notice && (
        <p className="mt-3 rounded-lg border border-amber-300 bg-amber-50 p-2 text-xs text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200">
          {notice}
        </p>
      )}

      <div className="mt-4">
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
  const [pending, startTransition] = useTransition();

  function complete() {
    startTransition(async () => {
      const r = await setTaskStatusAction(task.id, "done");
      if (r.ok && r.reminderNote) onNotice(r.reminderNote);
      else if (!r.ok) onNotice(r.message);
      router.refresh();
    });
  }

  return (
    <div className="flex items-start gap-2 rounded-lg border border-neutral-200 p-2 dark:border-neutral-800">
      <button
        onClick={complete}
        disabled={pending || task.status === "done"}
        className="mt-0.5 h-4 w-4 shrink-0 rounded-full border border-neutral-400 disabled:opacity-40"
        aria-label="Complete"
        style={task.status === "done" ? { backgroundColor: "#059669", borderColor: "#059669" } : {}}
      />
      <button onClick={() => onEdit(task)} className="min-w-0 flex-1 text-left">
        <div className="flex items-center gap-2">
          <span
            className="inline-block h-2 w-2 shrink-0 rounded-full"
            style={{ backgroundColor: PRIORITY_DOT[task.priority] }}
          />
          <span className={"truncate text-sm " + (task.status === "done" ? "line-through text-neutral-400" : "")}>
            {task.title}
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

  function triage(task: TaskRow, status: TaskRow["status"]) {
    startTransition(async () => {
      await setTaskStatusAction(task.id, status);
      router.refresh();
    });
  }

  return (
    <div>
      <QuickAdd workStreams={workStreams} onNotice={onNotice} />
      {inbox.length === 0 ? (
        <p className="mt-4 text-sm text-neutral-400">Inbox is empty.</p>
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
                  onClick={() => triage(t, "todo")}
                  disabled={pending}
                  className="shrink-0 rounded-lg border border-neutral-300 px-2 py-1 text-xs disabled:opacity-50 dark:border-neutral-700"
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
  const columns: { key: TaskRow["status"]; label: string }[] = [
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
            <h3 className="mb-2 text-sm font-medium text-neutral-500">
              {col.label} ({items.length})
            </h3>
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
                        {col.key !== "todo" && (
                          <button
                            onClick={() => move(t, col.key === "done" ? "doing" : "todo")}
                            disabled={pending}
                            className="rounded border border-neutral-300 px-1.5 py-0.5 text-[11px] dark:border-neutral-700"
                          >
                            ‹
                          </button>
                        )}
                        {col.key !== "done" && (
                          <button
                            onClick={() => move(t, col.key === "todo" ? "doing" : "done")}
                            disabled={pending}
                            className="rounded border border-neutral-300 px-1.5 py-0.5 text-[11px] dark:border-neutral-700"
                          >
                            ›
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
    if (!confirm("Delete this project? Its tasks stay as unfiled.")) return;
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
        <button onClick={() => setSelected(null)} className="text-sm text-neutral-500">
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
        className="rounded-lg border border-neutral-300 px-3 py-1.5 text-sm dark:border-neutral-700"
      >
        + Project
      </button>
      {adding && (
        <div className="mt-2 space-y-2 rounded-lg border border-neutral-200 p-3 dark:border-neutral-800">
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
            className="rounded-lg bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
          >
            Add
          </button>
        </div>
      )}
      <div className="mt-3 space-y-2">
        {projects.length === 0 ? (
          <p className="text-sm text-neutral-400">No projects yet.</p>
        ) : (
          projects.map((p) => {
            const count = tasks.filter((t) => t.project_id === p.id).length;
            return (
              <div
                key={p.id}
                className="flex items-center justify-between rounded-lg border border-neutral-200 p-2 dark:border-neutral-800"
              >
                <button onClick={() => setSelected(p.id)} className="text-left">
                  <p className="text-sm font-medium">{p.name}</p>
                  <p className="text-[11px] text-neutral-500">
                    {wsById.get(p.work_stream_id)} · {count} task{count === 1 ? "" : "s"}
                  </p>
                </button>
                <div className="flex items-center gap-1">
                  <select
                    value={p.status}
                    onChange={(e) => setStatus(p.id, e.target.value as ProjectRow["status"])}
                    className="rounded border border-neutral-300 px-1 py-0.5 text-[11px] dark:border-neutral-700 dark:bg-neutral-900"
                  >
                    <option value="active">active</option>
                    <option value="on_hold">on hold</option>
                    <option value="done">done</option>
                    <option value="dropped">dropped</option>
                  </select>
                  <button
                    onClick={() => removeProject(p.id)}
                    className="text-[11px] text-red-600"
                  >
                    Delete
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
        className="w-32 shrink-0 rounded-lg border border-neutral-300 px-2 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-900"
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
        className="shrink-0 rounded-lg bg-indigo-600 px-3 text-sm font-medium text-white disabled:opacity-50"
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
  offsets: string;
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
    offsets: (t?.remind_offsets ?? [7, 3, 1, 0]).join(", "),
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
    const offsets = f.offsets
      .split(/[,\s]+/)
      .map((x) => parseInt(x, 10))
      .filter((n) => Number.isInteger(n) && n >= 0 && n <= 28);
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
    if (!confirm("Delete this task?")) return;
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
        <div className="flex gap-2">
          <Field label="Status">
            <select
              value={f.status}
              onChange={(e) => setF({ ...f, status: e.target.value as TaskRow["status"] })}
              className={inputCls}
            >
              <option value="inbox">Inbox</option>
              <option value="todo">To do</option>
              <option value="doing">Doing</option>
              <option value="done">Done</option>
              <option value="dropped">Dropped</option>
            </select>
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
        </div>
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
            <Field label="Remind (days before, comma separated; max 5, max 28)">
              <input
                value={f.offsets}
                onChange={(e) => setF({ ...f, offsets: e.target.value })}
                className={inputCls}
              />
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

        {err && <p className="text-sm text-red-600">{err}</p>}
        <div className="flex gap-2">
          <button
            onClick={submit}
            disabled={pending}
            className="flex-1 rounded-lg bg-indigo-600 px-3 py-2 text-sm font-medium text-white disabled:opacity-50"
          >
            {pending ? "Saving" : isEdit ? "Save" : "Create"}
          </button>
          {isEdit && (
            <button
              onClick={remove}
              disabled={pending}
              className="rounded-lg border border-neutral-300 px-3 py-2 text-sm text-red-600 disabled:opacity-50 dark:border-neutral-700"
            >
              Delete
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
