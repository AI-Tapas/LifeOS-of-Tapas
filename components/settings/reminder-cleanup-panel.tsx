"use client";

// Settings: the one-off tidy-up that goes with M7a. The migration stopped the
// routine tasks writing calendar events, but the events they wrote before it
// are still on the calendar and SQL cannot delete them. This button removes
// them, and it is safe to press twice.

import { useState, useTransition } from "react";
import { clearInAppCalendarEntriesAction } from "@/app/(app)/settings/actions";

export default function ReminderCleanupPanel() {
  const [pending, startTransition] = useTransition();
  const [note, setNote] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  function run() {
    setNote(null);
    setErr(null);
    startTransition(async () => {
      const r = await clearInAppCalendarEntriesAction();
      if (!r.ok) {
        setErr(r.message ?? "Could not clear the entries.");
        return;
      }
      const cleared = r.cleared ?? 0;
      setNote(
        cleared === 0
          ? "Nothing left to clear. Your calendar is already tidy."
          : `Cleared ${cleared} calendar ${cleared === 1 ? "entry" : "entries"}.` +
              (r.skipped ? ` ${r.skipped} could not be reached; press again later.` : "")
      );
    });
  }

  return (
    <div className="rounded-2xl border border-border bg-surface p-4 shadow-[var(--shadow-card)]">
      <p className="text-sm text-secondary">
        Trip checklist steps and the monthly invoice task no longer put
        anything on your Google Calendar. The entries they created before that
        change are still there. This removes them. Nothing leaves the app, and
        pressing it twice is harmless.
      </p>
      <button
        onClick={run}
        disabled={pending}
        className="press mt-3 min-h-11 rounded-lg border border-border-strong px-3 py-2 text-sm disabled:opacity-50"
      >
        {pending ? "Clearing" : "Clear the old calendar entries"}
      </button>
      {note && <p className="mt-2 text-sm text-ok">{note}</p>}
      {err && <p className="mt-2 text-sm text-overdue">{err}</p>}
    </div>
  );
}
