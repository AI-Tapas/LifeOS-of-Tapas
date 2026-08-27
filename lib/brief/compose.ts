// Pure composer for the 7 AM IST morning brief email. No Supabase, no
// fetch: it takes already-loaded rows and returns subject/html/text, so the
// cron route is a thin I/O shell and this is exercised offline in
// scripts/m5.test.ts with plain fixtures.
//
// Ranking must never disagree with Home, so this reuses the exact same
// triage/weekendGuard functions Home and the Tasks overview already share.
// Relative .ts imports so node --test (type stripping, no bundler) resolves
// them, same convention lib/tasks/triage.ts itself uses.

import {
  triage,
  weekendGuard,
  type TriageTask,
} from "../tasks/triage.ts";
import {
  addDays,
  civilKey,
  civilToday,
  civilWeekday,
  formatDateIST,
  formatDateShortIST,
  formatTimeIST,
  formatWeekdayLongIST,
  istDayKey,
  istInstant,
  startOfWeek,
} from "../datetime.ts";
import { accountColor } from "../account-colors.ts";

export interface BriefTask extends TriageTask {
  stream: string;
  source: string; // task_source: 'manual' | 'email' | 'assistant'
  created_at: string;
}

export interface BriefEvent {
  id: string;
  title: string;
  start_ts: string;
  all_day: boolean;
  account_slot: string | null;
  account_label: string | null;
}

export interface BriefAccountIssue {
  slot: string;
  label: string | null;
}

export interface ComposeBriefInput {
  nowMs: number;
  tasks: BriefTask[]; // open tasks: status in inbox/todo/doing
  events: BriefEvent[]; // today's events, all connected accounts, pre-sorted by start_ts (this does not re-sort, same contract as the events query's own .order("start_ts"))
  pendingApprovalsCount: number;
  accountsNeedingReconnect: BriefAccountIssue[];
  appBaseUrl: string;
}

export interface ComposedBrief {
  subject: string;
  html: string;
  text: string;
}

const COLORS = {
  canvas: "#F8F9FB",
  card: "#FFFFFF",
  cardBorder: "#E8EBF0",
  heading: "#14283F",
  muted: "#5B6472",
  clay: "#A66E5E",
  overdueText: "#9E4339",
  overdueBg: "#F4E3E0",
  todayText: "#A06F2C",
  todayBg: "#F6EBD8",
  waitingText: "#4D7AA3",
  waitingBg: "#DBE6F0",
};
const FONT = "Georgia, 'Times New Roman', Times, serif";
const MAX_SUBJECT_ITEM_LEN = 80;

const BAND_LABELS: Record<"do_first" | "important" | "urgent", string> = {
  do_first: "Do first",
  important: "Important, not urgent",
  urgent: "Urgent, less important",
};

export function composeBrief(input: ComposeBriefInput): ComposedBrief {
  const { nowMs, tasks, events, pendingApprovalsCount, accountsNeedingReconnect, appBaseUrl } =
    input;
  const nowIso = new Date(nowMs).toISOString();
  const today = civilToday(nowMs);
  const weekday = civilWeekday(today);

  const bands = triage(tasks, nowMs);
  const topItem = bands.do_first[0] ?? bands.important[0] ?? bands.urgent[0] ?? null;

  const saturday = addDays(startOfWeek(today), 5);
  const guardKeys: [string, string, string] = [
    civilKey(saturday),
    civilKey(addDays(saturday, 1)),
    civilKey(addDays(saturday, 2)),
  ];
  const weekendRisk = weekendGuard(tasks, weekday, guardKeys);

  // "Last night's mail scan" = the one automated scan, which runs at 03:00
  // IST. Tasks it proposed all land with source 'email' and a created_at
  // after today's IST midnight, so that's the whole filter: no run id
  // exists to join on instead (see prompts/M5-scan-mail-followups...).
  const todayMidnightIso = istInstant(today, 0, 0).toISOString();
  const scannedTasks = tasks.filter(
    (t) => t.source === "email" && t.created_at >= todayMidnightIso
  );

  const dateHeading = `${formatWeekdayLongIST(nowIso)}, ${formatDateIST(nowIso)}`;
  const narrative = topItem ? `The one thing to do first today: ${topItem.title}.` : "Desk clear.";
  const topTitle = topItem ? truncate(topItem.title, MAX_SUBJECT_ITEM_LEN) : null;
  const subject = topTitle ? `Your day: ${topTitle}` : "Your day: desk clear";

  const html = renderHtml({
    dateHeading,
    narrative,
    accountsNeedingReconnect,
    weekendRisk,
    bands,
    events,
    pendingApprovalsCount,
    scannedTasks,
    nowIso,
    appBaseUrl,
  });
  const text = renderText({
    dateHeading,
    narrative,
    accountsNeedingReconnect,
    weekendRisk,
    bands,
    events,
    pendingApprovalsCount,
    scannedTasks,
    nowIso,
    appBaseUrl,
  });

  return { subject, html, text };
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}...` : s;
}

function dueState(dueTs: string | null, nowIso: string): { label: string; tone: "neutral" | "overdue" | "today" } {
  if (!dueTs) return { label: "no deadline", tone: "neutral" };
  const overdue = dueTs < nowIso && istDayKey(dueTs) !== istDayKey(nowIso);
  const isToday = istDayKey(dueTs) === istDayKey(nowIso);
  if (overdue) return { label: "overdue", tone: "overdue" };
  if (isToday) return { label: "today", tone: "today" };
  return { label: formatDateShortIST(dueTs), tone: "neutral" };
}

// ---------------------------------------------------------------------------
// HTML rendering. Table layout, every style inline, no webfonts: this is
// read in Gmail (web and app), which strips <style> blocks unpredictably.
// ---------------------------------------------------------------------------

interface RenderInput {
  dateHeading: string;
  narrative: string;
  accountsNeedingReconnect: BriefAccountIssue[];
  weekendRisk: BriefTask[];
  bands: ReturnType<typeof triage<BriefTask>>;
  events: BriefEvent[];
  pendingApprovalsCount: number;
  scannedTasks: BriefTask[];
  nowIso: string;
  appBaseUrl: string;
}

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function chip(label: string, tone: "neutral" | "overdue" | "today" | "waiting"): string {
  const pair =
    tone === "overdue"
      ? [COLORS.overdueBg, COLORS.overdueText]
      : tone === "today"
        ? [COLORS.todayBg, COLORS.todayText]
        : tone === "waiting"
          ? [COLORS.waitingBg, COLORS.waitingText]
          : [COLORS.cardBorder, COLORS.heading];
  return `<span style="display:inline-block;padding:2px 8px;border-radius:999px;background-color:${pair[0]};color:${pair[1]};font-size:11px;font-family:${FONT};white-space:nowrap;">${esc(label)}</span>`;
}

function taskRow(t: BriefTask, nowIso: string): string {
  const ds = dueState(t.due_ts, nowIso);
  const chipHtml = ds.tone === "neutral" && t.due_ts ? "" : chip(ds.label, ds.tone);
  const plainDate = ds.tone === "neutral" && t.due_ts ? `<span style="font-size:12px;color:${COLORS.muted};font-family:${FONT};">${esc(ds.label)}</span>` : "";
  return `
    <tr>
      <td style="padding:6px 0;border-top:1px solid ${COLORS.cardBorder};">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
          <td style="font-family:${FONT};">
            <div style="font-size:14px;color:${COLORS.heading};">${esc(t.title)}</div>
            <div style="font-size:12px;color:${COLORS.muted};margin-top:2px;">${esc(t.stream)}</div>
          </td>
          <td align="right" style="white-space:nowrap;padding-left:12px;">${chipHtml}${plainDate}</td>
        </tr></table>
      </td>
    </tr>`;
}

function bandSection(key: "do_first" | "important" | "urgent", items: BriefTask[], nowIso: string): string {
  if (!items.length) return "";
  return `
    <tr><td style="padding:16px 32px 0 32px;">
      <h2 style="margin:0 0 4px 0;font-size:13px;color:${COLORS.muted};font-family:${FONT};text-transform:uppercase;letter-spacing:0.03em;">${esc(BAND_LABELS[key])}</h2>
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
        ${items.map((t) => taskRow(t, nowIso)).join("")}
      </table>
    </td></tr>`;
}

function renderHtml(r: RenderInput): string {
  const empty = r.bands.do_first.length + r.bands.important.length + r.bands.urgent.length === 0;

  const reconnectBlock = r.accountsNeedingReconnect.length
    ? `
    <tr><td style="padding:12px 32px 0 32px;">
      <div style="border-radius:10px;background-color:${COLORS.overdueBg};padding:12px 14px;">
        <p style="margin:0;font-size:13px;color:${COLORS.overdueText};font-family:${FONT};">
          ${r.accountsNeedingReconnect
            .map((a) => `${esc(a.label ?? a.slot)} needs reconnecting`)
            .join(", ")}. Open Settings to reconnect.
        </p>
      </div>
    </td></tr>`
    : "";

  const weekendBlock = r.weekendRisk.length
    ? `
    <tr><td style="padding:12px 32px 0 32px;">
      <div style="border-radius:10px;background-color:${COLORS.todayBg};padding:14px;">
        <p style="margin:0;font-size:13px;font-weight:bold;color:${COLORS.todayText};font-family:${FONT};">
          Weekend at risk: ${r.weekendRisk.length === 1 ? "a deadline lands" : `${r.weekendRisk.length} deadlines land`} between Saturday and Monday.
        </p>
        <ul style="margin:6px 0 0 0;padding-left:18px;">
          ${r.weekendRisk
            .slice(0, 3)
            .map(
              (t) =>
                `<li style="font-size:12px;color:${COLORS.todayText};font-family:${FONT};">${esc(t.title)}, due ${formatDateIST(t.due_ts!)}</li>`
            )
            .join("")}
        </ul>
        <p style="margin:6px 0 0 0;font-size:12px;color:${COLORS.todayText};font-family:${FONT};">Start it before Friday evening, or the weekend pays for it.</p>
      </div>
    </td></tr>`
    : "";

  const bandsHtml = empty
    ? `
    <tr><td style="padding:16px 32px 0 32px;">
      <p style="margin:0;font-size:14px;font-weight:bold;color:${COLORS.heading};font-family:${FONT};">Desk clear.</p>
      <p style="margin:4px 0 0 0;font-size:13px;color:${COLORS.muted};font-family:${FONT};">Nothing urgent, nothing important waiting.</p>
    </td></tr>`
    : [
        bandSection("do_first", r.bands.do_first, r.nowIso),
        bandSection("important", r.bands.important, r.nowIso),
        bandSection("urgent", r.bands.urgent, r.nowIso),
      ].join("");

  const eventsHtml = r.events.length
    ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0">
        ${r.events
          .map((e) => {
            const hex = accountColor(e.account_slot).hex;
            const when = e.all_day ? "All day" : formatTimeIST(e.start_ts);
            return `
          <tr><td style="padding:5px 0;font-family:${FONT};">
            <table role="presentation" cellpadding="0" cellspacing="0"><tr>
              <td style="width:8px;">
                <span style="display:inline-block;width:8px;height:8px;border-radius:50%;background-color:${hex};"></span>
              </td>
              <td style="width:70px;padding-left:8px;font-size:13px;color:${COLORS.muted};">${esc(when)}</td>
              <td style="padding-left:4px;font-size:13px;color:${COLORS.heading};">${esc(e.title)}</td>
              <td style="padding-left:8px;font-size:12px;color:${COLORS.muted};">${esc(e.account_label ?? e.account_slot ?? "")}</td>
            </tr></table>
          </td></tr>`;
          })
          .join("")}
      </table>`
    : `<p style="margin:0;font-size:13px;color:${COLORS.muted};font-family:${FONT};">No meetings today. A clear runway for the Do first list.</p>`;

  const approvalsBlock = r.pendingApprovalsCount
    ? `
    <tr><td style="padding:16px 32px 0 32px;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
        <td style="border-radius:10px;background-color:${COLORS.waitingBg};padding:12px 14px;">
          <a href="${r.appBaseUrl}/assistant?tab=queue" style="text-decoration:none;font-size:13px;color:${COLORS.waitingText};font-family:${FONT};">
            ${r.pendingApprovalsCount} ${r.pendingApprovalsCount === 1 ? "item is" : "items are"} waiting for your approval. Open Assistant.
          </a>
        </td>
      </tr></table>
    </td></tr>`
    : "";

  const scannedBlock = r.scannedTasks.length
    ? `
    <tr><td style="padding:16px 32px 0 32px;">
      <h2 style="margin:0 0 4px 0;font-size:13px;color:${COLORS.muted};font-family:${FONT};text-transform:uppercase;letter-spacing:0.03em;">From last night's mail scan</h2>
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
        ${r.scannedTasks.map((t) => taskRow(t, r.nowIso)).join("")}
      </table>
      <p style="margin:8px 0 0 0;"><a href="${r.appBaseUrl}/tasks" style="font-size:12px;color:${COLORS.clay};font-family:${FONT};">Open the Tasks inbox</a></p>
    </td></tr>`
    : "";

  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:${COLORS.canvas};padding:24px 12px;">
  <tr><td align="center">
    <table role="presentation" width="560" cellpadding="0" cellspacing="0" style="max-width:560px;width:100%;background-color:${COLORS.card};border:1px solid ${COLORS.cardBorder};border-radius:12px;">
      <tr><td style="padding:28px 32px 0 32px;">
        <p style="margin:0;font-size:12px;letter-spacing:0.04em;color:${COLORS.clay};font-family:${FONT};text-transform:uppercase;">${esc(r.dateHeading)}</p>
        <h1 style="margin:6px 0 0 0;font-size:21px;color:${COLORS.heading};font-family:${FONT};">Good morning, Tapas.</h1>
        <p style="margin:10px 0 0 0;font-size:15px;color:${COLORS.heading};font-family:${FONT};">${esc(r.narrative)}</p>
      </td></tr>
      ${reconnectBlock}
      ${weekendBlock}
      ${bandsHtml}
      <tr><td style="padding:20px 32px 0 32px;">
        <div style="border-top:1px solid ${COLORS.cardBorder};padding-top:14px;">
          <h2 style="margin:0 0 8px 0;font-size:13px;color:${COLORS.muted};font-family:${FONT};text-transform:uppercase;letter-spacing:0.03em;">Today</h2>
          ${eventsHtml}
        </div>
      </td></tr>
      ${approvalsBlock}
      ${scannedBlock}
      <tr><td style="padding:24px 32px 28px 32px;">
        <div style="border-top:1px solid ${COLORS.cardBorder};padding-top:14px;">
          <a href="${r.appBaseUrl}/" style="font-size:12px;color:${COLORS.clay};font-family:${FONT};">Open Life OS</a>
        </div>
      </td></tr>
    </table>
  </td></tr>
</table>`;
}

function renderText(r: RenderInput): string {
  const lines: string[] = [r.dateHeading, "", r.narrative, ""];

  if (r.accountsNeedingReconnect.length) {
    lines.push(
      `${r.accountsNeedingReconnect.map((a) => `${a.label ?? a.slot} needs reconnecting`).join(", ")}. Open Settings to reconnect.`,
      ""
    );
  }

  if (r.weekendRisk.length) {
    lines.push(
      `Weekend at risk: ${r.weekendRisk.length === 1 ? "a deadline lands" : `${r.weekendRisk.length} deadlines land`} between Saturday and Monday.`
    );
    for (const t of r.weekendRisk.slice(0, 3)) lines.push(`- ${t.title}, due ${formatDateIST(t.due_ts!)}`);
    lines.push("Start it before Friday evening, or the weekend pays for it.", "");
  }

  const empty = r.bands.do_first.length + r.bands.important.length + r.bands.urgent.length === 0;
  if (empty) {
    lines.push("Desk clear. Nothing urgent, nothing important waiting.", "");
  } else {
    for (const key of ["do_first", "important", "urgent"] as const) {
      const items = r.bands[key];
      if (!items.length) continue;
      lines.push(BAND_LABELS[key] + ":");
      for (const t of items) {
        const ds = dueState(t.due_ts, r.nowIso);
        lines.push(`- ${t.title} (${t.stream}) - ${ds.label}`);
      }
      lines.push("");
    }
  }

  lines.push("Today:");
  if (r.events.length) {
    for (const e of r.events) {
      const when = e.all_day ? "All day" : formatTimeIST(e.start_ts);
      lines.push(`- ${when} ${e.title} (${e.account_label ?? e.account_slot ?? ""})`);
    }
  } else {
    lines.push("No meetings today. A clear runway for the Do first list.");
  }
  lines.push("");

  if (r.pendingApprovalsCount) {
    lines.push(
      `${r.pendingApprovalsCount} ${r.pendingApprovalsCount === 1 ? "item is" : "items are"} waiting for your approval: ${r.appBaseUrl}/assistant?tab=queue`,
      ""
    );
  }

  if (r.scannedTasks.length) {
    lines.push("From last night's mail scan:");
    for (const t of r.scannedTasks) lines.push(`- ${t.title} (${t.stream})`);
    lines.push(`Open the Tasks inbox: ${r.appBaseUrl}/tasks`, "");
  }

  lines.push(`Open Life OS: ${r.appBaseUrl}/`);
  return lines.join("\n");
}
