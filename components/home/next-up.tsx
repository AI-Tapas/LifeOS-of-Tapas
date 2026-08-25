"use client";

// The ranked "what should I do next" list on Home: Eisenhower bands, not a
// due-date queue. Each row can be completed in place, and an important task
// with no due date gets one-tap manufactured deadlines, because a date is the
// only lever that works (persona, section 4).

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { DueBadge, SectionLabel } from "@/components/ui";
import {
  setTaskStatusAction,
  updateTaskAction,
} from "@/app/(app)/tasks/actions";
import { addDays, civilToday, civilWeekday, istInstant } from "@/lib/datetime";

export interface NextUpRow {
  id: string;
  title: string;
  stream: string;
  due_ts: string | null;
  needs_deadline: boolean;
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
  tone: string;
  hint: string;
  cap: number;
}[] = [
  {
    key: "do_first",
    label: "Do first",
    tone: "text-overdue",
    hint: "Urgent and important.",
    cap: 6,
  },
  {
    key: "important",
    label: "Important, not urgent",
    tone: "text-accent",
    hint: "The work that slips when nobody chases it.",
    cap: 5,
  },
  {
    key: "urgent",
    label: "Urgent, less important",
    tone: "text-today",
    hint: "Deadline-driven. It can wait for the two lists above.",
    cap: 4,
  },
];

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

function Row({ row, nowIso }: { row: NextUpRow; nowIso: string }) {
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
    <li className="py-2 first:pt-0 last:pb-0">
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
              (done ? "border-ok bg-ok" : "border-neutral-400")
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

  return (
    <div>
      {empty ? (
        <div className="rounded-xl border border-dashed border-neutral-300 p-6 text-center dark:border-neutral-700">
          <p className="text-sm font-semibold">Desk clear.</p>
          <p className="mt-1 text-sm text-neutral-500">
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
          return (
            <section key={s.key} className="mt-4 first:mt-0">
              <div>
                <SectionLabel tone={s.tone}>{s.label}</SectionLabel>
                <p className="text-[11px] text-neutral-400">{s.hint}</p>
              </div>
              <ul className="mt-1 divide-y divide-neutral-100 dark:divide-neutral-900">
                {shown.map((r) => (
                  <Row key={r.id} row={r} nowIso={nowIso} />
                ))}
              </ul>
              {rows.length > shown.length && (
                <Link
                  href="/tasks"
                  className="text-xs font-medium text-neutral-500 underline-offset-2 hover:underline"
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
