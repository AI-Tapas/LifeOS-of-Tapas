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
import { civilKey, civilToday } from "../lib/datetime.ts";
import { buildLapsedReport, type LapsedRow } from "../lib/tasks/reports.ts";

// The pure part lives in lib/tasks/reports.ts since B22, shared with the
// connector tool lifeos_report_lapsed_tasks. Re-exported so the tests that
// import it from here still do.
export {
  OVERDUE_DAYS,
  buildLapsedReport,
  lapsedCandidates,
  looksLikeWindow,
  type LapsedRow,
} from "../lib/tasks/reports.ts";

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
