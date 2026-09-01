"use client";

// Notes, on screen at last. The assistant and both connectors have been able
// to write notes since M4, so there may already be rows here he has never
// seen; the whole point of this panel is that things stop going in and
// staying invisible.
//
// A reference is only worth showing if it can be followed, so the task, the
// trip and each person are links, not decoration. The work stream is a label:
// there is no screen for one stream, and a chip that goes nowhere is what this
// panel exists to avoid.

import { useMemo, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  Drawer,
  Empty,
  Field,
  btnGhost,
  btnPrimary,
  drawerFooterCls,
  inputCls,
} from "@/components/ui";
import {
  NOTE_TYPES,
  NOTE_TYPE_LABELS,
  newestFirst,
  noteDateLabel,
  notePreview,
  searchNotes,
  type Note,
  type NoteType,
} from "@/lib/brain/notes";
import {
  createNoteAction,
  updateNoteAction,
  deleteNoteAction,
  type NoteInput,
} from "@/app/(app)/brain/actions";

export type NoteRow = Note;
export interface NamedRow {
  id: string;
  name: string;
}

export interface NotesPanelProps {
  notes: NoteRow[];
  workStreams: NamedRow[];
  people: NamedRow[];
  tasks: NamedRow[];
  trips: NamedRow[];
}

const chipCls =
  "inline-flex items-center rounded-full border border-border-strong px-2.5 py-0.5 text-[11px] text-secondary";
const linkChipCls =
  "press inline-flex min-h-8 items-center rounded-full border border-accent/40 bg-accent-soft px-2.5 py-0.5 text-[11px] font-medium text-accent";

export default function NotesPanel(props: NotesPanelProps) {
  const { notes, workStreams, people, tasks, trips } = props;
  const [query, setQuery] = useState("");
  const [editing, setEditing] = useState<NoteRow | "new" | null>(null);

  const nameOf = useMemo(() => {
    const m = new Map<string, string>();
    for (const r of [...workStreams, ...people, ...tasks, ...trips]) m.set(r.id, r.name);
    return m;
  }, [workStreams, people, tasks, trips]);

  const shown = useMemo(
    () => searchNotes(newestFirst(notes), query),
    [notes, query]
  );

  return (
    <div>
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-lg font-medium">Notes</h2>
          <p className="text-sm text-secondary">
            Meetings, decisions, ideas and references, newest first. Your own
            words only: no documents live here.
          </p>
        </div>
        <button
          onClick={() => setEditing("new")}
          className="shrink-0 rounded-lg bg-accent px-3 py-1.5 text-sm font-medium text-white dark:text-neutral-950"
        >
          + Add
        </button>
      </div>

      <div className="mt-3">
        <label className="sr-only" htmlFor="note-search">
          Search notes
        </label>
        <input
          id="note-search"
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          className={inputCls}
          placeholder="Search titles and bodies"
        />
        {query.trim() !== "" && (
          <p className="mt-1 text-xs text-secondary">
            {shown.length} of {notes.length} notes match.
          </p>
        )}
      </div>

      <ul className="mt-4 space-y-2">
        {shown.length === 0 ? (
          <li>
            <Empty title={notes.length === 0 ? "No notes yet" : "Nothing matches"}>
              {notes.length === 0
                ? "Write down what a meeting decided, or what you want to remember about a client, and tie it to the work it came from."
                : "Try one word instead of three: every word has to appear in the title or the body."}
            </Empty>
          </li>
        ) : (
          shown.map((n) => (
            <li
              key={n.id}
              className="rounded-lg border border-border bg-surface p-3 shadow-[var(--shadow-card)]"
            >
              <button
                onClick={() => setEditing(n)}
                className="block w-full text-left"
              >
                <div className="flex items-baseline justify-between gap-2">
                  <p className="min-w-0 font-medium">{n.title}</p>
                  <span className="shrink-0 text-[11px] text-secondary">
                    {NOTE_TYPE_LABELS[n.type]}
                  </span>
                </div>
                <p className="text-xs text-secondary">{noteDateLabel(n)}</p>
                {n.body_md && (
                  <p className="mt-1 text-sm text-secondary">
                    {notePreview(n.body_md)}
                  </p>
                )}
              </button>
              <NoteLinks note={n} nameOf={nameOf} />
            </li>
          ))
        )}
      </ul>

      {editing && (
        <NoteForm
          note={editing === "new" ? null : editing}
          workStreams={workStreams}
          people={people}
          tasks={tasks}
          trips={trips}
          onClose={() => setEditing(null)}
        />
      )}
    </div>
  );
}

// Everything the note points at. The stream is a label; the task, the trip and
// each person go somewhere.
function NoteLinks({
  note,
  nameOf,
}: {
  note: NoteRow;
  nameOf: Map<string, string>;
}) {
  const streamName = note.work_stream_id ? nameOf.get(note.work_stream_id) : null;
  const taskName = note.task_id ? nameOf.get(note.task_id) : null;
  const tripName = note.trip_id ? nameOf.get(note.trip_id) : null;
  const linkedPeople = note.people_ids
    .map((id) => ({ id, name: nameOf.get(id) }))
    .filter((p): p is { id: string; name: string } => !!p.name);

  if (!streamName && !taskName && !tripName && linkedPeople.length === 0) return null;

  return (
    <div className="mt-2 flex flex-wrap items-center gap-1.5">
      {streamName && <span className={chipCls}>{streamName}</span>}
      {taskName && note.task_id && (
        <Link href={`/tasks?task=${note.task_id}`} className={linkChipCls}>
          Task: {taskName}
        </Link>
      )}
      {tripName && note.trip_id && (
        <Link href={`/trips/${note.trip_id}`} className={linkChipCls}>
          Trip: {tripName}
        </Link>
      )}
      {linkedPeople.map((p) => (
        <Link
          key={p.id}
          href={`/brain?tab=people&person=${p.id}`}
          className={linkChipCls}
        >
          {p.name}
        </Link>
      ))}
    </div>
  );
}

interface Fields {
  type: NoteType;
  title: string;
  body: string;
  occurredOn: string;
  workStreamId: string;
  taskId: string;
  tripId: string;
  peopleIds: string[];
}

function toFields(n: NoteRow | null): Fields {
  return {
    type: n?.type ?? "meeting",
    title: n?.title ?? "",
    body: n?.body_md ?? "",
    occurredOn: n?.occurred_on ?? "",
    workStreamId: n?.work_stream_id ?? "",
    taskId: n?.task_id ?? "",
    tripId: n?.trip_id ?? "",
    peopleIds: n?.people_ids ?? [],
  };
}

function NoteForm({
  note,
  workStreams,
  people,
  tasks,
  trips,
  onClose,
}: {
  note: NoteRow | null;
  workStreams: NamedRow[];
  people: NamedRow[];
  tasks: NamedRow[];
  trips: NamedRow[];
  onClose: () => void;
}) {
  const router = useRouter();
  const [f, setF] = useState<Fields>(() => toFields(note));
  const [pending, startTransition] = useTransition();
  const [err, setErr] = useState<string | null>(null);
  const [armed, setArmed] = useState(false);
  const isEdit = !!note;

  function togglePerson(id: string) {
    setF({
      ...f,
      peopleIds: f.peopleIds.includes(id)
        ? f.peopleIds.filter((x) => x !== id)
        : [...f.peopleIds, id],
    });
  }

  function submit() {
    setErr(null);
    setArmed(false);
    const input: NoteInput = {
      type: f.type,
      title: f.title,
      body: f.body || null,
      occurred_on: f.occurredOn || null,
      work_stream_id: f.workStreamId || null,
      people_ids: f.peopleIds,
      task_id: f.taskId || null,
      trip_id: f.tripId || null,
    };
    startTransition(async () => {
      const r = isEdit
        ? await updateNoteAction(note!.id, input)
        : await createNoteAction(input);
      if (r.ok) {
        onClose();
        router.refresh();
      } else {
        setErr(r.message);
      }
    });
  }

  function remove() {
    if (!note) return;
    if (!armed) {
      setArmed(true);
      return;
    }
    startTransition(async () => {
      await deleteNoteAction(note.id);
      onClose();
      router.refresh();
    });
  }

  return (
    <Drawer title={isEdit ? "Edit note" : "New note"} onClose={onClose}>
      <div className="space-y-3">
        <Field label="Title">
          <input
            value={f.title}
            onChange={(e) => setF({ ...f, title: e.target.value })}
            className={inputCls}
            placeholder="e.g. Call with the Rajkot branch"
          />
        </Field>
        <div className="flex gap-2">
          <Field label="Kind">
            <select
              value={f.type}
              onChange={(e) => setF({ ...f, type: e.target.value as NoteType })}
              className={inputCls}
            >
              {NOTE_TYPES.map((t) => (
                <option key={t} value={t}>
                  {NOTE_TYPE_LABELS[t]}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Day it is about">
            <input
              type="date"
              value={f.occurredOn}
              onChange={(e) => setF({ ...f, occurredOn: e.target.value })}
              className={inputCls}
            />
          </Field>
        </div>
        <Field label="Note">
          <textarea
            value={f.body}
            onChange={(e) => setF({ ...f, body: e.target.value })}
            className={inputCls}
            rows={6}
          />
        </Field>
        <p className="text-xs text-secondary">
          Your own words and references only. No client documents, and nothing
          to attach one to.
        </p>
        <Field label="Work stream">
          <select
            value={f.workStreamId}
            onChange={(e) => setF({ ...f, workStreamId: e.target.value })}
            className={inputCls}
          >
            <option value="">No stream</option>
            {workStreams.map((w) => (
              <option key={w.id} value={w.id}>
                {w.name}
              </option>
            ))}
          </select>
        </Field>
        <div className="flex gap-2">
          <Field label="About a task">
            <select
              value={f.taskId}
              onChange={(e) => setF({ ...f, taskId: e.target.value })}
              className={inputCls}
            >
              <option value="">None</option>
              {tasks.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="From a trip">
            <select
              value={f.tripId}
              onChange={(e) => setF({ ...f, tripId: e.target.value })}
              className={inputCls}
            >
              <option value="">None</option>
              {trips.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
          </Field>
        </div>
        {people.length > 0 && (
          <div>
            <span className="text-xs font-medium text-secondary">People</span>
            <div className="mt-1 flex flex-wrap gap-1.5">
              {people.map((p) => {
                const on = f.peopleIds.includes(p.id);
                return (
                  <button
                    key={p.id}
                    type="button"
                    aria-pressed={on}
                    onClick={() => togglePerson(p.id)}
                    className={
                      "press min-h-11 rounded-full border px-3.5 text-sm " +
                      (on
                        ? "border-accent bg-accent text-white dark:text-neutral-950"
                        : "border-border-strong text-secondary")
                    }
                  >
                    {p.name}
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {err && <p className="text-sm text-overdue">{err}</p>}
        <div className={drawerFooterCls + " flex gap-2"}>
          <button onClick={submit} disabled={pending} className={btnPrimary + " flex-1"}>
            {pending ? "Saving" : isEdit ? "Save" : "Create"}
          </button>
          {isEdit && (
            <button
              onClick={remove}
              disabled={pending}
              className={
                armed
                  ? "press min-h-11 rounded-xl bg-red-600 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
                  : btnGhost + " text-overdue"
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
