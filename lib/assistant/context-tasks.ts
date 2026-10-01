// The open-task part of the assistant's app context (lib/assistant/context.ts),
// pure so scripts/b22.test.ts can read what the model is shown.
//
// Since B22 every row, the scanned-email ones included, names its work stream
// and the date it was created: without them a connected model could not tell
// a fortnight-old ICAI chaser from this morning's Personal errand. Mail-derived
// rows stay inside the untrusted-data fence (attack A2), waiting or not. The
// caller keeps the 30-row cap on its query.

import { formatDateIST } from "../datetime.ts";
import { fenceUntrusted } from "./prompt.ts";
import { isUntrustedSource } from "../tasks/untrusted.ts";

export interface ContextTask {
  id: string;
  title: string;
  status: string;
  priority: string;
  priority_source: string;
  priority_reason: string | null;
  due_ts: string | null;
  not_before: string | null;
  source: string;
  created_at: string;
  stream: string;
}

export function taskContextLines(tasks: ContextTask[], todayKey: string): string[] {
  const isWaiting = (t: ContextTask) => !!t.not_before && t.not_before > todayKey;
  const startsLabel = (t: ContextTask) => formatDateIST(`${t.not_before}T04:00:00Z`);
  const due = (t: ContextTask) => (t.due_ts ? formatDateIST(t.due_ts) : "no due date");
  const created = (t: ContextTask) => formatDateIST(t.created_at);
  const trusted = tasks.filter((t) => !isUntrustedSource(t.source) && !isWaiting(t));
  const waiting = tasks.filter((t) => !isUntrustedSource(t.source) && isWaiting(t));
  const fromMail = tasks.filter((t) => isUntrustedSource(t.source));

  // "set by" is not decoration: a priority marked Tapas is his own judgment
  // and may never be changed, whatever the assistant now thinks. The reason
  // column is there so a rating it gave earlier can be revisited honestly.
  const rating = (t: ContextTask) =>
    `${t.priority} | ${
      t.priority_source === "manual" ? "Tapas, do not change" : "assistant"
    }${t.priority_reason ? ` | ${t.priority_reason}` : ""}`;

  const lines: string[] = [
    "",
    "Open tasks (id | title | stream | priority | set by | why | due | status | created):",
  ];
  if (!trusted.length) lines.push("  none");
  for (const t of trusted) {
    lines.push(`  ${t.id} | ${t.title} | ${t.stream} | ${rating(t)} | ${due(t)} | ${t.status} | created ${created(t)}`);
  }

  // B19. A task that cannot start before a later date is not on today's
  // list, so it is named apart with its start date: the model still has its
  // id but is told plainly that it is neither current nor urgent.
  if (waiting.length) {
    lines.push(
      "",
      "Waiting for their start date (cannot start yet, never urgent before then; not for today) (id | title | stream | starts | due | created):"
    );
    for (const t of waiting) {
      lines.push(`  ${t.id} | ${t.title} | ${t.stream} | ${startsLabel(t)} | ${due(t)} | created ${created(t)}`);
    }
  }

  if (fromMail.length) {
    const body = fromMail
      .map(
        (t) =>
          `${t.id} | ${t.title} | ${t.stream} | ${rating(t)} | ${due(t)} | ${t.status} | created ${created(t)}${
            isWaiting(t) ? ` | waiting, cannot start before ${startsLabel(t)}` : ""
          }`
      )
      .join("\n");
    lines.push(
      "",
      fenceUntrusted("tasks created from scanned email or shared text (id | title | stream | priority | set by | why | due | status | created)", body)
    );
  }
  return lines;
}
