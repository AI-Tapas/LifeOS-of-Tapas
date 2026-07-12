"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { quickAddTaskAction } from "@/app/(app)/tasks/actions";

// Quick-add a task to the inbox from anywhere in the app shell. A floating
// button that opens a one-line form; the task lands in the inbox for triage.
export default function QuickAddTask({
  workStreams,
}: {
  workStreams: { id: string; name: string }[];
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [wsId, setWsId] = useState(workStreams[0]?.id ?? "");
  const [pending, startTransition] = useTransition();
  const [note, setNote] = useState<string | null>(null);

  if (workStreams.length === 0) return null;

  function add() {
    if (!title.trim() || !wsId) return;
    startTransition(async () => {
      const r = await quickAddTaskAction(title.trim(), wsId);
      if (!r.ok) {
        setNote(r.message);
        return;
      }
      setTitle("");
      setNote("Added to inbox.");
      router.refresh();
      setTimeout(() => setNote(null), 2000);
    });
  }

  return (
    <div className="fixed bottom-16 right-4 z-30">
      {open ? (
        <div className="w-72 rounded-xl border border-neutral-200 bg-white p-3 shadow-lg dark:border-neutral-800 dark:bg-neutral-950">
          <div className="mb-2 flex items-center justify-between">
            <span className="text-xs font-semibold text-neutral-500">Quick task</span>
            <button onClick={() => setOpen(false)} className="text-xs text-neutral-400">
              Close
            </button>
          </div>
          <input
            autoFocus
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && add()}
            placeholder="What needs doing?"
            className="w-full rounded-lg border border-neutral-300 px-3 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-900"
          />
          <select
            value={wsId}
            onChange={(e) => setWsId(e.target.value)}
            className="mt-2 w-full rounded-lg border border-neutral-300 px-2 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-900"
          >
            {workStreams.map((w) => (
              <option key={w.id} value={w.id}>
                {w.name}
              </option>
            ))}
          </select>
          {note && <p className="mt-2 text-xs text-neutral-500">{note}</p>}
          <button
            onClick={add}
            disabled={pending}
            className="mt-2 w-full rounded-lg bg-indigo-600 px-3 py-2 text-sm font-medium text-white disabled:opacity-50"
          >
            {pending ? "Adding" : "Add to inbox"}
          </button>
        </div>
      ) : (
        <button
          onClick={() => setOpen(true)}
          className="h-12 w-12 rounded-full bg-indigo-600 text-2xl leading-none text-white shadow-lg"
          aria-label="Quick add task"
        >
          +
        </button>
      )}
    </div>
  );
}
