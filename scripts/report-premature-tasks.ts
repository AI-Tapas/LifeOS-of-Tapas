// B19 one-off review report. READ ONLY: it changes nothing, anywhere.
//
// Lists, for Tapas to review by hand:
//   1. open tasks whose title names a future month or year (the October and
//      November invoices sitting in "urgent" in September), and
//   2. open tasks that look like repeats of each other (the near-duplicate
//      score create_task now refuses on, lib/tasks/near-duplicate.ts).
// What to do about each one is his call: set "Can start from" on the task,
// or drop the spare copy. This script never does either.
//
// Run by Tapas, from the app folder, against his own data:
//   npm run report:premature
// which is: node --env-file=.env.local scripts/report-premature-tasks.ts
// It needs NEXT_PUBLIC_SUPABASE_URL (or SUPABASE_URL) and
// SUPABASE_SERVICE_ROLE_KEY from .env.local, and prints to the terminal only.
// Nothing is written to a file, sent, or stored.
//
// The only database call below is one select. scripts/b19.test.ts reads this
// file and fails if an insert, update, delete, upsert or rpc ever appears.

import { createClient } from "@supabase/supabase-js";
import { pathToFileURL } from "node:url";
import { civilKey, civilToday } from "../lib/datetime.ts";
import { buildReport, type ReportRow } from "../lib/tasks/reports.ts";

// The pure part lives in lib/tasks/reports.ts since B22, shared with the
// connector tool lifeos_report_premature_tasks. Re-exported so the tests that
// import it from here still do.
export { buildReport, duplicatePairs, prematureTasks, type ReportRow } from "../lib/tasks/reports.ts";

async function main(): Promise<void> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    console.error(
      "Missing NEXT_PUBLIC_SUPABASE_URL (or SUPABASE_URL) and SUPABASE_SERVICE_ROLE_KEY. Run it as: npm run report:premature"
    );
    process.exitCode = 1;
    return;
  }
  const supabase = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data, error } = await supabase
    .from("tasks")
    .select("id, title, status, due_ts, not_before, trip_id")
    .in("status", ["inbox", "todo", "doing"]);
  if (error) {
    console.error(`Could not read the tasks: ${error.message}`);
    process.exitCode = 1;
    return;
  }
  console.log(buildReport((data ?? []) as ReportRow[], civilKey(civilToday())));
}

// Runs only when invoked directly, so the test can import buildReport.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exitCode = 1;
  });
}
