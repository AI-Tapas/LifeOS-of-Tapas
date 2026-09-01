"use client";

// The ranked "what should I do next" list on Home: Eisenhower bands, not a
// due-date queue. Each row can be completed in place, and an important task
// with no due date gets one-tap manufactured deadlines, because a date is the
// only lever that works (persona, section 4).

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { BandHead, DueBadge, PriorityReason } from "@/components/ui";
import {
  setTaskStatusAction,
  updateTaskAction,
} from "@/app/(app)/tasks/actions";
import { addDays, civilToday, civilWeekday, istInstant } from "@/lib/datetime";
import type { PrioritySource } from "@/lib/tasks/priority";

export interface NextUpRow {
  id: string;
  title: string;
  stream: string;
  due_ts: string | null;
  needs_deadline: boolean;
  // Why this task ranks where it ranks, when the assistant is the one who
  // decided. Shown as a quiet footnote under the row: this list is an
  // assertion about his work, so it says what it is asserting and why.
  priority_source?: PrioritySource;
  priority_reason?: string | null;
  // Set when the row stands for a whole trip's checklist rather than one
  // task. It ranks by its most urgent open step, and opens the trip: there
  // is nothing here to tick, because the steps live on that screen.
  trip_id?: string | null;
}

export interface NextUpBands {
  do_first: NextUpRow[];
  important: NextUpRow[];
  urgent: NextUpRow[];
  later_count: number;
}

const SECTIONS: {
  key: keyof Omit<NextUpBands, "later_count">;
  label: string;
  hint: string;
  cap: number;
}[] = [
  {
    key: "do_first",
    label: "Do first",
    hint: "Urgent and important.",
    cap: 6,
  },
  {
    key: "important",
    label: "Important, not urgent",
    hint: "The work that slips when nobody chases it.",
    cap: 5,
  },
  {
    key: "urgent",
    label: "Urgent, less important",
    hint: "Deadline-driven. It can wait for the two lists above.",
    cap: 4,
  },
];

// Items past this position all arrive together.
const STAGGER_CAP = 7;

// Manufactured-deadline choices, all at 9:30 am IST like every task due date.
function deadlineChoices(): { label: string; iso: string }[] {
  const today = civilToday();
  const nextMondayOffset = ((8 - civilWeekday(today)) % 7) || 7;
  return [
    { label: "Tomorrow", iso: istInstant(addDays(today, 1), 9, 30).toISOString() },
    { label: "In 3 days", iso: istInstant(addDays(today, 3), 9, 30).toISOString() },
    {
      label: "Next Monday",
      iso: istInstant(addDays(today, nextMondayOffset), 9, 30).toISOString(),
    },
  ];
}

// A trip's rolled-up line. Same rank, same due badge, same place in the
// band as the step that earned it, so nothing is hidden: only the four other
// steps are folded away, one tap from here.
function TripRow({
  row,
  nowIso,
  arriveIndex,
}: {
  row: NextUpRow;
  nowIso: string;
  arriveIndex: number;
}) {
  return (
    <li className="arrive py-2 first:pt-0 last:pb-0" style={{ ["--i" as string]: arriveIndex }}>
      <Link href={`/trips/${row.trip_id}`} className="press flex items-center gap-3">
        <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-brand-soft text-[9px] font-bold uppercase tracking-[0.08em] text-brand-deep">
          Trip
        </span>
        <span className="min-w-0 flex-1">
          <span className="block break-words text-sm font-medium">{row.title}</span>
          <span className="block text-[11px] text-neutral-500">{row.stream}</span>
        </span>
        <DueBadge dueTs={row.due_ts} nowIso={nowIso} flagMissing={false} />
      </Link>
    </li>
  );
}

function Row({
  row,
  nowIso,
  arriveIndex,
}: {
  row: NextUpRow;
  nowIso: string;
  arriveIndex: number;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [done, setDone] = useState(false);
  const [dated, setDated] = useState(false);

  function complete() {
    setDone(true);
    startTransition(async () => {
      const r = await setTaskStatusAction(row.id, "done");
      if (!r.ok) setDone(false);
      router.refresh();
    });
  }

  function schedule(iso: string) {
    setDated(true);
    startTransition(async () => {
      const r = await updateTaskAction(row.id, { due_ts: iso });
      if (!r.ok) setDated(false);
      router.refresh();
    });
  }

  return (
    <li
      // Arrival is staggered by position; completion leaves an "ok" tint that
      // fades over the row before the refreshed list drops it.
      className={
        "arrive py-2 first:pt-0 last:pb-0" + (done ? " settle-done" : "")
      }
      style={{ ["--i" as string]: arriveIndex }}
    >
      <div className="flex items-center gap-3">
        <button
          onClick={complete}
          disabled={pending || done}
          aria-label={`Mark done: ${row.title}`}
          className={
            "press flex h-11 w-11 shrink-0 items-center justify-center rounded-full " +
            (done ? "pop-done" : "")
          }
        >
          <span
            className={
              "flex h-5 w-5 items-center justify-center rounded-full border-2 " +
              (done ? "border-ok bg-ok" : "border-border-strong")
            }
          >
            {done && (
              <svg viewBox="0 0 12 12" className="h-3 w-3 text-white dark:text-neutral-950">
                <path
                  d="m2.5 6.5 2.5 2.5 4.5-5"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            )}
          </span>
        </button>
        <div className="min-w-0 flex-1">
          <p
            className={
              "break-words text-sm font-medium " +
              (done ? "text-neutral-400 line-through" : "")
            }
          >
            {row.title}
          </p>
          <p className="text-[11px] text-neutral-500">{row.stream}</p>
          {!done && (
            <PriorityReason
              reason={row.priority_reason}
              source={row.priority_source}
              className="mt-0.5"
            />
          )}
        </div>
        <DueBadge dueTs={row.due_ts} nowIso={nowIso} />
      </div>
      {row.needs_deadline && !dated && !done && (
        <div className="mt-1.5 flex flex-wrap items-center gap-1.5 pl-14">
          <span className="text-[11px] text-neutral-500">Give it a deadline:</span>
          {deadlineChoices().map((c) => (
            <button
              key={c.label}
              onClick={() => schedule(c.iso)}
              disabled={pending}
              className="press min-h-11 rounded-full border border-accent/40 px-3 text-xs font-medium text-accent disabled:opacity-50"
            >
              {c.label}
            </button>
          ))}
        </div>
      )}
      {dated && !done && (
        <p className="mt-1 pl-14 text-[11px] text-ok">
          Deadline set. It now behaves like a real one.
        </p>
      )}
    </li>
  );
}

export default function NextUp({
  bands,
  nowIso,
}: {
  bands: NextUpBands;
  nowIso: string;
}) {
  const empty =
    bands.do_first.length + bands.important.length + bands.urgent.length === 0;

  // Arrival order for the stagger, counted across bands and rows together so
  // the screen assembles top to bottom. Capped at eight: past that the tail of
  // a long list would still be trickling in when the thumb reaches it. Pure
  // per render, and CSS animations only replay when an element remounts, so a
  // data refresh (completing a task, say) never re-runs the entrance.
  let arrived = 0;
  const next = () => Math.min(arrived++, STAGGER_CAP);

  return (
    <div>
      {empty ? (
        <div className="rise-in rounded-xl border border-dashed border-border-strong p-6 text-center">
          <p className="text-sm font-semibold">Desk clear.</p>
          <p className="mt-1 text-sm text-secondary">
            Nothing urgent, nothing important waiting. Capture new work with the
            + button, or give a low-priority task a look in{" "}
            <Link href="/tasks" className="font-medium text-accent">
              Tasks
            </Link>
            .
          </p>
        </div>
      ) : (
        SECTIONS.map((s) => {
          const rows = bands[s.key];
          if (rows.length === 0) return null;
          const shown = rows.slice(0, s.cap);
          const bandIndex = next();
          return (
            <section
              key={s.key}
              className="arrive mt-6 first:mt-0"
              style={{ ["--i" as string]: bandIndex }}
            >
              <BandHead title={s.label} count={rows.length} />
              <p className="mt-1.5 text-[11px] text-muted">{s.hint}</p>
              <ul className="mt-1 divide-y divide-border">
                {shown.map((r) =>
                  r.trip_id ? (
                    <TripRow key={r.id} row={r} nowIso={nowIso} arriveIndex={next()} />
                  ) : (
                    <Row key={r.id} row={r} nowIso={nowIso} arriveIndex={next()} />
                  )
                )}
              </ul>
              {rows.length > shown.length && (
                <Link
                  href="/tasks"
                  className="text-xs font-medium text-secondary underline-offset-2 hover:underline"
                >
                  +{rows.length - shown.length} more in Tasks
                </Link>
              )}
            </section>
          );
        })
      )}
      {bands.later_count > 0 && (
        <p className="mt-3 text-xs text-neutral-400">
          {bands.later_count} more open task{bands.later_count === 1 ? "" : "s"}{" "}
          with time on {bands.later_count === 1 ? "its" : "their"} side, in{" "}
          <Link href="/tasks" className="font-medium text-neutral-500">
            Tasks
          </Link>
          .
        </p>
      )}
    </div>
  );
}
