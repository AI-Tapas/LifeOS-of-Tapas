// B20 one-off review report. READ ONLY: it changes nothing, anywhere.
//
// Since B20 a task can carry lapses_on, and the 7 AM brief drops it once that
// window has closed. Tasks created before B20 have no lapses_on and are NEVER
// auto-dropped. This lists the open email-sourced ones that look like a closed
// window, for Tapas to review by hand:
//   - due more than 3 days ago, and
//   - a title or note that reads like a window: early bird, e-vote, RSVP,
//     register by, before N PM, or a day-only event (webinar, workshop,
//     seminar, conference, faculty day, session day).
// What to do about each is his call: mark it Dropped (undoable) or leave it.
//
// Run by Tapas, from the app folder, against his own data:
//   npm run report:lapsed
// which is: node --env-file=.env.local scripts/report-lapsed-tasks.ts
// It needs NEXT_PUBLIC_SUPABASE_URL (or SUPABASE_URL) and
// SUPABASE_SERVICE_ROLE_KEY from .env.local, and prints to the terminal only.
//
// The only database call below is one select. scripts/b20.test.ts reads this
// file and fails if an insert, update, delete, upsert or rpc ever appears.

import { createClient } from "@supabase/supabase-js";
import { pathToFileURL } from "node:url";
import { civilKey, civilToday, formatDateIST } from "../lib/datetime.ts";

export interface LapsedRow {
  id: string;
  title: string;
  notes: string | null;
  status: string;
  source: string;
  due_ts: string | null;
  lapses_on: string | null;
}

export const OVERDUE_DAYS = 3;

// ponytail: a phrase list, not a classifier. It only chooses what goes on a
// list he reads; nothing acts on it. Add a phrase when a window slips past.
const WINDOW =
  /\b(early[- ]?bird|e-?vot(e|ing)|rsvp|register by|registration (closes|ends)|last date (to|for) regist\w*|before \d{1,2}(:\d{2})?\s*(am|pm)|webinar|workshop|seminar|conference|faculty day|session day)\b/i;

export function looksLikeWindow(title: string, notes: string | null): boolean {
  return WINDOW.test(title) || WINDOW.test(notes ?? "");
}

function istKey(iso: string): string {
  return new Date(Date.parse(iso) + 330 * 60000).toISOString().slice(0, 10);
}

function shiftKey(key: string, days: number): string {
  const [y, m, d] = key.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

// Pure, so the offline test can check it with fixtures.
export function lapsedCandidates(rows: LapsedRow[], todayKey: string): LapsedRow[] {
  const cutoff = shiftKey(todayKey, -OVERDUE_DAYS);
  return rows.filter(
    (r) =>
      ["inbox", "todo", "doing"].includes(r.status) &&
      r.source === "email" &&
      !r.lapses_on &&
      !!r.due_ts &&
      istKey(r.due_ts) < cutoff &&
      looksLikeWindow(r.title, r.notes)
  );
}

export function buildLapsedReport(rows: LapsedRow[], todayKey: string): string {
  const hits = lapsedCandidates(rows, todayKey);
  const lines = [
    `Life OS: open mail tasks that look like closed windows, ${formatDateIST(`${todayKey}T04:00:00Z`)}`,
    "Nothing has been changed. Review each one and decide.",
    "",
    `Open email tasks due more than ${OVERDUE_DAYS} days ago that read like a window: ${hits.length}`,
  ];
  for (const r of hits) {
    lines.push(`   - ${r.title} | due ${formatDateIST(r.due_ts!)} | id ${r.id}`);
  }
  if (hits.length) {
    lines.push("   If the window has closed, mark it Dropped in Tasks, which can be undone.");
  }
  return lines.join("\n");
}

async function main(): Promise<void> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    console.error(
      "Missing NEXT_PUBLIC_SUPABASE_URL (or SUPABASE_URL) and SUPABASE_SERVICE_ROLE_KEY. Run it as: npm run report:lapsed"
    );
    process.exitCode = 1;
    return;
  }
  const supabase = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data, error } = await supabase
    .from("tasks")
    .select("id, title, notes, status, source, due_ts, lapses_on")
    .in("status", ["inbox", "todo", "doing"]);
  if (error) {
    console.error(`Could not read the tasks: ${error.message}`);
    process.exitCode = 1;
    return;
  }
  console.log(buildLapsedReport((data ?? []) as LapsedRow[], civilKey(civilToday())));
}

// Runs only when invoked directly, so the test can import the pure parts.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exitCode = 1;
  });
}
