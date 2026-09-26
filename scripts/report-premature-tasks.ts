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
import {
  duplicateScore,
  namedFuturePeriod,
  NEAR_DUPLICATE_THRESHOLD,
} from "../lib/tasks/near-duplicate.ts";
import { civilKey, civilToday, formatDateIST } from "../lib/datetime.ts";

export interface ReportRow {
  id: string;
  title: string;
  status: string;
  due_ts: string | null;
  not_before: string | null;
}

function dayLabel(key: string): string {
  return formatDateIST(`${key}T04:00:00Z`);
}

// Pure, so the offline test can check it with fixtures.
export function buildReport(rows: ReportRow[], todayKey: string): string {
  const open = rows.filter((r) => ["inbox", "todo", "doing"].includes(r.status));
  const lines: string[] = [
    `Life OS: open tasks to review, ${dayLabel(todayKey)}`,
    "Nothing has been changed. Review each one and decide.",
    "",
  ];

  const premature = open
    .map((r) => ({ r, period: namedFuturePeriod(r.title, todayKey) }))
    .filter((x) => x.period !== null);
  lines.push(`1. Open tasks that name a future month or year: ${premature.length}`);
  for (const { r, period } of premature) {
    const starts =
      r.not_before && r.not_before > todayKey
        ? `already waiting until ${dayLabel(r.not_before)}`
        : "no start date set";
    lines.push(
      `   - ${r.title} | names ${period} | ${
        r.due_ts ? `due ${formatDateIST(r.due_ts)}` : "no due date"
      } | ${starts} | id ${r.id}`
    );
  }
  if (premature.length) {
    lines.push(
      "   If one cannot start yet, open it in Tasks and set Can start from (or ask the assistant to set its not_before)."
    );
  }
  lines.push("");

  // ponytail: every pair compared, O(n squared). A few hundred open tasks is
  // tens of thousands of comparisons, well under a second.
  const pairs: { a: ReportRow; b: ReportRow; score: number }[] = [];
  for (let i = 0; i < open.length; i++) {
    for (let j = i + 1; j < open.length; j++) {
      const score = duplicateScore(open[i].title, open[j].title);
      if (score >= NEAR_DUPLICATE_THRESHOLD) pairs.push({ a: open[i], b: open[j], score });
    }
  }
  lines.push(`2. Open tasks that look like repeats of each other: ${pairs.length} pair${pairs.length === 1 ? "" : "s"}`);
  for (const { a, b, score } of pairs) {
    lines.push(
      `   - "${a.title}" and "${b.title}" (match ${score.toFixed(2)}) | ids ${a.id}, ${b.id}`
    );
  }
  if (pairs.length) {
    lines.push("   Keep one of each pair and mark the other Dropped, which can be undone.");
  }
  return lines.join("\n");
}

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
    .select("id, title, status, due_ts, not_before")
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
