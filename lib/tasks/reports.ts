// The two read-only task reviews, shared by the terminal scripts
// (npm run report:lapsed, npm run report:premature) and, since B22, the
// connector reads lifeos_report_lapsed_tasks and lifeos_report_premature_tasks.
// Moved here from scripts/ so both callers run the same logic. Nothing in this
// file reads or writes a database: it takes rows and returns a list and text.
// Pure, relative imports only.

import {
  duplicateScore,
  namedFuturePeriod,
  NEAR_DUPLICATE_THRESHOLD,
} from "./near-duplicate.ts";
import { formatDateIST } from "../datetime.ts";

const OPEN = ["inbox", "todo", "doing"];

// ---------------------------------------------------------------------------
// B20. Open mail tasks that look like a closed window.
// ---------------------------------------------------------------------------
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

export function lapsedCandidates(rows: LapsedRow[], todayKey: string): LapsedRow[] {
  const cutoff = shiftKey(todayKey, -OVERDUE_DAYS);
  return rows.filter(
    (r) =>
      OPEN.includes(r.status) &&
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

// ---------------------------------------------------------------------------
// B19. Open tasks naming a future period, and near-duplicate pairs.
// ---------------------------------------------------------------------------
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

export function prematureTasks(
  rows: ReportRow[],
  todayKey: string
): { row: ReportRow; period: string }[] {
  return rows
    .filter((r) => OPEN.includes(r.status))
    .map((row) => ({ row, period: namedFuturePeriod(row.title, todayKey) }))
    .filter((x): x is { row: ReportRow; period: string } => x.period !== null);
}

export function duplicatePairs(rows: ReportRow[]): { a: ReportRow; b: ReportRow; score: number }[] {
  const open = rows.filter((r) => OPEN.includes(r.status));
  // ponytail: every pair compared, O(n squared). A few hundred open tasks is
  // tens of thousands of comparisons, well under a second.
  const pairs: { a: ReportRow; b: ReportRow; score: number }[] = [];
  for (let i = 0; i < open.length; i++) {
    for (let j = i + 1; j < open.length; j++) {
      const score = duplicateScore(open[i].title, open[j].title);
      if (score >= NEAR_DUPLICATE_THRESHOLD) pairs.push({ a: open[i], b: open[j], score });
    }
  }
  return pairs;
}

export function buildReport(rows: ReportRow[], todayKey: string): string {
  const lines: string[] = [
    `Life OS: open tasks to review, ${dayLabel(todayKey)}`,
    "Nothing has been changed. Review each one and decide.",
    "",
  ];

  const premature = prematureTasks(rows, todayKey);
  lines.push(`1. Open tasks that name a future month or year: ${premature.length}`);
  for (const { row: r, period } of premature) {
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

  const pairs = duplicatePairs(rows);
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
