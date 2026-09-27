// On-demand mail-to-task. Pipeline isolation (attack A1): each account is
// scanned in its OWN model context whose tool set is exactly one tool,
// propose_task. No send, draft, calendar or person tool exists in that
// context; validateScanProposals discards anything else the model emits, and
// external_ref must match a scanned message, so provenance cannot be forged.
// Bodies are never stored: tasks carry a short title, a short note and the
// message ref only (attack A2).
//
// B20 adds a second isolated turn, the ticket pass: mail from allowlisted
// ticket senders only (scan-filters.ts isTicketSender) is read in full (body
// text, never attachments) by a context whose one tool is propose_trip_leg,
// and a valid leg is written on its trip through the log_trip_leg performer.
// No PNR, city or mail text reaches an audit row: ids, counts and matched
// filter phrases only.

import { cookieActor, type Actor } from "@/lib/assistant/actor";
import { runLlmTurn } from "@/lib/assistant/llm";
import type { LlmOverride } from "@/lib/assistant/config";
import { SCAN_TOOL, TICKET_TOOL, disclosureOf } from "@/lib/assistant/tools";
import {
  SCAN_SYSTEM,
  TICKET_SYSTEM,
  buildScanUserMessage,
  buildTicketUserMessage,
  type ScanMail,
  type TicketMail,
} from "@/lib/assistant/prompt";
import {
  provenance,
  validateScanProposals,
  isCalendarInvite,
  type RawToolCall,
} from "@/lib/assistant/core";
import { loadLlmOverride } from "@/lib/assistant/settings";
import { listRecentGmail, listRecentGraph, mailRequest, type MailMeta } from "@/lib/assistant/mail";
import { readMessageBody } from "@/lib/assistant/mailbox";
import {
  dropKnownMail,
  isAppGeneratedMail,
  isAlreadyOpen,
  isNoiseMail,
  isTicketSender,
  matchesNeverExtract,
  sourceKey,
} from "@/lib/assistant/scan-filters";
import { logScannedTripLeg } from "@/lib/assistant/execute";
import { TICKET_LEG_CAP, validateTripLegProposals } from "@/lib/trips/ticket";
import { createTask } from "@/lib/tasks/write";
import { istInstant } from "@/lib/datetime";
import type { Json } from "@/lib/database.types";

// A6: proposals are capped per account per day so a mailbox flood cannot
// bury the task list. Five, not twenty: at twenty the list filled with
// bills and notices faster than he could read it.
const DAILY_CAP = 5;

// B20: how far back the repeat checks look. A thread with work created in
// the last 45 days (the isAlreadyOpen memory) is not read again; the same
// sender and subject within 14 days is a resend.
const THREAD_MEMORY_DAYS = 45;
const RESEND_MEMORY_DAYS = 14;
const OPEN_TITLES_FOR_MODEL = 40;

export interface ScanSummary {
  scanned: number;
  created: number;
  skipped: number;
  // B20: trip legs recorded from ticket mail.
  legs: number;
  notes: string[];
}

// Slot -> work stream the scanner files tasks under when the model named
// none. Since B20 the prompt judges by topic, with the mailbox a tie-break.
const SLOT_STREAM: Record<string, string> = {
  taxstrategia: "Tax Strategia",
  ca_tapasnr: "Personal",
  altechon: "Altechon",
  icai: "ICAI",
};

type ScanAccount = { id: string; slot: string; provider: string; email: string };

// The actor is passed in so this runs identically for the signed-in owner in
// the app and for the MCP connector, which has no cookie and arrives with the
// service actor instead. Writing tasks through lib/tasks/write rather than the
// "use server" action keeps this off the server-action path entirely.
export async function runMailScan(actor?: Actor): Promise<ScanSummary> {
  const owner = actor ?? (await cookieActor());
  const { supabase } = owner;

  const { data: accounts } = await supabase
    .from("accounts")
    .select("id, slot, provider, status, connect_mode, email")
    .eq("status", "connected")
    .eq("connect_mode", "direct");

  const summary: ScanSummary = { scanned: 0, created: 0, skipped: 0, legs: 0, notes: [] };
  const override = await loadLlmOverride(supabase, "scan");
  // Trip legs have their own cap per run, across accounts, and do not count
  // against the daily task cap.
  let legBudget = TICKET_LEG_CAP;

  for (const account of accounts ?? []) {
    if (!account.slot) continue;
    const acc: ScanAccount = {
      id: account.id,
      slot: account.slot,
      provider: account.provider,
      email: account.email,
    };
    let mails: MailMeta[];
    try {
      mails =
        account.provider === "google"
          ? await listRecentGmail(account.id)
          : await listRecentGraph(account.id);
    } catch (e) {
      summary.notes.push(
        `${account.slot}: ${e instanceof Error ? e.message : "mail fetch failed"}`
      );
      continue;
    }
    if (!mails.length) continue;
    summary.scanned += mails.length;
    const fetched = mails.length;

    // Calendar invitations are the calendar's business, not the task list's:
    // the event already syncs into the app, so a task would duplicate it.
    // Dropped here rather than left to the model, which treated them as
    // actionable.
    const invites = mails.filter(isCalendarInvite).length;
    if (invites) {
      mails = mails.filter((m) => !isCalendarInvite(m));
      summary.notes.push(
        `${account.slot}: skipped ${invites} calendar ${
          invites === 1 ? "invitation" : "invitations"
        }`
      );
    }

    // The app's own mail, above all the morning brief, which is sent from this
    // account to itself and so lands in the inbox being scanned. Reading it
    // back turned the brief's own task list into fresh tasks, one copy per
    // day, for ever.
    const ownMail = mails.filter((m) => isAppGeneratedMail(m, account.email)).length;
    if (ownMail) {
      mails = mails.filter((m) => !isAppGeneratedMail(m, account.email));
      summary.notes.push(
        `${account.slot}: skipped ${ownMail} Life OS ${
          ownMail === 1 ? "message" : "messages"
        }`
      );
    }

    // Bills, statements, alerts, bounces and codes: mail a machine sent that
    // needs no reply. The model was asked to skip these and did not, so the
    // rule is code now. Ticket senders are exempt (B20): their e-tickets are
    // exactly the no-reply receipts this drops.
    const noise = mails.filter(isNoiseMail).length;
    if (noise) {
      mails = mails.filter((m) => !isNoiseMail(m));
      summary.notes.push(`${account.slot}: skipped ${noise} automated ${noise === 1 ? "notice" : "notices"}`);
    }
    if (!mails.length) continue;

    const refOf = (id: string) => `${account.provider === "google" ? "gmail" : "graph"}:${account.slot}:${id}`;

    const tickets = await ticketPass(owner, acc, mails, refOf, legBudget, override);
    legBudget -= tickets.legs;
    summary.legs += tickets.legs;
    summary.notes.push(...tickets.notes);

    const tasks = await taskPass(owner, acc, mails, refOf, override);
    summary.created += tasks.created;
    summary.skipped += tasks.skipped;
    summary.notes.push(...tasks.notes);

    await supabase.from("audit_log").insert({
      user_id: owner.userId,
      actor: "assistant",
      action: "mail_scan",
      entity: "accounts",
      entity_id: account.id,
      meta: {
        slot: account.slot,
        scanned: fetched,
        proposed: tasks.proposed,
        rejected: tasks.rejected,
        // B20. Counts and matched filter phrases only, never mail text.
        dropped_by_thread: tasks.byThread,
        dropped_by_resend: tasks.byResend,
        never_extract: tasks.neverExtract,
        tickets_read: tickets.read,
        trip_legs_logged: tickets.legs,
        tickets_without_trip: tickets.withoutTrip,
        ticket_rejected: tickets.rejected,
        // The scan is the one tool allowed to see message bodies, so its rows
        // say so, and say whether it was Tapas or the 03:00 cron that asked.
        provenance: provenance({
          basis: "autonomous_bucket",
          tool: "scan_mail",
          disclosure: disclosureOf("scan_mail"),
          actorOrigin: owner.origin,
          originatingJob: owner.job,
        }),
      } as unknown as Json,
    });
  }
  return summary;
}

// ---------------------------------------------------------------------------
// B20. The ticket pass.
// ---------------------------------------------------------------------------
async function ticketPass(
  owner: Actor,
  account: ScanAccount,
  mails: MailMeta[],
  refOf: (id: string) => string,
  legBudget: number,
  override: LlmOverride | undefined
): Promise<{ read: number; legs: number; withoutTrip: number; rejected: string[]; notes: string[] }> {
  const { supabase, userId } = owner;
  const out = { read: 0, legs: 0, withoutTrip: 0, rejected: [] as string[], notes: [] as string[] };
  let candidates = mails.filter((m) => isTicketSender(m.from));
  if (!candidates.length || legBudget <= 0) return out;

  // A ticket already recorded on a trip is not read again on the next night.
  const { data: done } = await supabase
    .from("assistant_actions")
    .select("payload")
    .eq("user_id", userId)
    .eq("kind", "log_trip_leg")
    .in("payload->>external_ref", candidates.map((m) => refOf(m.id)));
  const logged = new Set(
    (done ?? []).map((r) => String((r.payload as Record<string, unknown> | null)?.external_ref ?? ""))
  );
  candidates = candidates.filter((m) => !logged.has(refOf(m.id)));
  if (!candidates.length) return out;

  const request = mailRequest(account.id);
  const ticketMails: TicketMail[] = [];
  for (const m of candidates) {
    try {
      ticketMails.push({
        ref: refOf(m.id),
        from: m.from,
        subject: m.subject,
        date: m.date,
        body: await readMessageBody(request, account, m.id),
      });
    } catch {
      out.notes.push(`${account.slot}: could not read one ticket email`);
    }
  }
  out.read = ticketMails.length;
  if (!ticketMails.length) return out;

  const { data: trips } = await supabase
    .from("trips")
    .select("id, start_date, end_date, legs, status")
    .eq("user_id", userId)
    .neq("status", "cancelled")
    .not("start_date", "is", null);

  const turn = await runLlmTurn({
    blocks: [{ text: TICKET_SYSTEM, stable: true }],
    conv: [{ kind: "text", role: "user", text: buildTicketUserMessage(ticketMails) }],
    tools: [TICKET_TOOL],
    maxTokens: 1024,
    override,
  });
  if (turn.stop === "refusal") {
    out.notes.push(`${account.slot}: the model declined the ticket pass`);
    return out;
  }
  const { accepted, rejected, withoutTrip } = validateTripLegProposals(
    turn.calls.map((c): RawToolCall => ({ name: c.name, input: c.input })),
    new Set(ticketMails.map((m) => m.ref)),
    trips ?? [],
    legBudget
  );
  out.rejected = rejected;
  out.withoutTrip = withoutTrip.size;
  for (const t of accepted) {
    try {
      await logScannedTripLeg(owner, t, account.id);
      out.legs += 1;
    } catch (e) {
      out.notes.push(`${account.slot}: ${e instanceof Error ? e.message : "could not record a ticket leg"}`);
    }
  }
  if (out.legs) {
    out.notes.push(`${account.slot}: recorded ${out.legs} trip ${out.legs === 1 ? "leg" : "legs"} from ticket mail`);
  }
  if (out.withoutTrip) {
    out.notes.push(
      `${account.slot}: ${out.withoutTrip} ticket ${out.withoutTrip === 1 ? "email" : "emails"} did not match a trip`
    );
  }
  return out;
}

// ---------------------------------------------------------------------------
// The task pass.
// ---------------------------------------------------------------------------
async function taskPass(
  owner: Actor,
  account: ScanAccount,
  mailsIn: MailMeta[],
  refOf: (id: string) => string,
  override: LlmOverride | undefined
): Promise<{
  proposed: number;
  created: number;
  skipped: number;
  rejected: string[];
  byThread: number;
  byResend: number;
  neverExtract: string[];
  notes: string[];
}> {
  const { supabase, userId } = owner;
  const out = {
    proposed: 0,
    created: 0,
    skipped: 0,
    rejected: [] as string[],
    byThread: 0,
    byResend: 0,
    neverExtract: [] as string[],
    notes: [] as string[],
  };

  // B20, before the model sees anything: a mail whose thread already has an
  // open task (or any task from the last 45 days), or whose sender and
  // normalised subject match a task from the last 14 days, is a chaser or a
  // resend. The subject is compared as a hash; its text is never stored.
  const memoryFrom = new Date(Date.now() - THREAD_MEMORY_DAYS * 86400000).toISOString();
  const resendFrom = new Date(Date.now() - RESEND_MEMORY_DAYS * 86400000).toISOString();
  const { data: sourced } = await supabase
    .from("tasks")
    .select("external_thread, source_key, created_at")
    .eq("user_id", userId)
    .eq("source", "email")
    .or(`status.in.(inbox,todo,doing),created_at.gte.${memoryFrom}`);
  const known = { threads: new Set<string>(), keys: new Set<string>() };
  for (const r of sourced ?? []) {
    if (r.external_thread) known.threads.add(r.external_thread);
    if (r.source_key && r.created_at >= resendFrom) known.keys.add(r.source_key);
  }
  const { kept, byThread, byResend } = dropKnownMail(mailsIn, known);
  out.byThread = byThread;
  out.byResend = byResend;
  if (byThread || byResend) {
    out.notes.push(
      `${account.slot}: skipped ${byThread + byResend} ${
        byThread + byResend === 1 ? "email" : "emails"
      } already on the list by thread or resend`
    );
  }
  if (!kept.length) return out;

  const mailByRef = new Map(kept.map((m) => [refOf(m.id), m]));
  const scanMails: ScanMail[] = kept.map((m) => ({
    ref: refOf(m.id),
    account: account.slot,
    from: m.from,
    subject: m.subject,
    date: m.date,
    snippet: m.snippet,
  }));
  const knownRefs = new Set(scanMails.map((m) => m.ref));

  // Dedupe against tasks already created from these messages.
  const { data: existing } = await supabase
    .from("tasks")
    .select("external_ref")
    .in("external_ref", [...knownRefs]);
  for (const row of existing ?? []) {
    if (row.external_ref) knownRefs.delete(row.external_ref);
  }
  if (!knownRefs.size) return out;

  // Daily cap per account.
  const dayStartIst = istInstant(
    (() => {
      const now = new Date(Date.now() + 330 * 60000);
      return { y: now.getUTCFullYear(), m: now.getUTCMonth() + 1, d: now.getUTCDate() };
    })(),
    0,
    0
  ).toISOString();
  const { count } = await supabase
    .from("tasks")
    .select("id", { count: "exact", head: true })
    .eq("source", "email")
    .like("external_ref", `%:${account.slot}:%`)
    .gte("created_at", dayStartIst);
  const budget = Math.max(0, DAILY_CAP - (count ?? 0));
  if (!budget) {
    out.notes.push(`${account.slot}: daily cap of ${DAILY_CAP} reached`);
    return out;
  }

  // The real stream names, each with the hint he wrote for it (B20), so a
  // proposal can file itself by topic and the answer can be checked against
  // this exact list rather than trusted.
  const { data: streamRows } = await supabase
    .from("work_streams")
    .select("name, scan_hint")
    .eq("user_id", userId)
    .eq("active", true);
  const streams = streamRows ?? [];
  const streamNames = streams.map((s) => s.name);

  // Second belt, on meaning rather than message id: two AWS budget alerts,
  // or two chasers on one thread, are different messages saying the same
  // thing, so external_ref alone lets both through. Compare against what is
  // already open, and against anything he finished or dropped in the last
  // 45 days: a task he dropped must not come back because a chaser arrived.
  // Since B20 the open ones also go to the model, as data, so it can see
  // that one already covers an email.
  const { data: openRows } = await supabase
    .from("tasks")
    .select("title, status, created_at")
    .eq("user_id", userId)
    .or(`status.in.(inbox,todo,doing),created_at.gte.${memoryFrom}`)
    .order("created_at", { ascending: false });
  const openTitles = (openRows ?? []).map((r) => r.title);
  const openForModel = (openRows ?? [])
    .filter((r) => ["inbox", "todo", "doing"].includes(r.status))
    .slice(0, OPEN_TITLES_FOR_MODEL)
    .map((r) => r.title);

  // Isolated scanner context: one tool, no persona, mail fenced as data.
  const turn = await runLlmTurn({
    blocks: [{ text: SCAN_SYSTEM, stable: true }],
    conv: [
      {
        kind: "text",
        role: "user",
        text: buildScanUserMessage(
          scanMails.filter((m) => knownRefs.has(m.ref)),
          streams,
          openForModel
        ),
      },
    ],
    tools: [SCAN_TOOL],
    maxTokens: 2048,
    override,
  });
  if (turn.stop === "refusal") {
    out.notes.push(`${account.slot}: the model declined the scan`);
    return out;
  }

  const calls: RawToolCall[] = turn.calls.map((c) => ({
    name: c.name,
    input: c.input,
  }));
  const { accepted, rejected } = validateScanProposals(
    calls,
    knownRefs,
    budget,
    streamNames
  );
  out.proposed = accepted.length;
  out.rejected = rejected;
  out.skipped += rejected.length;

  // The mailbox a message arrives in is only the fallback. A proposal that
  // named one of his real streams wins.
  const defaultStreamName = SLOT_STREAM[account.slot] ?? "Personal";
  const defaultStreamId = await resolveStreamId(supabase, defaultStreamName);
  const streamIdCache = new Map<string, string>([
    [defaultStreamName, defaultStreamId],
  ]);
  const streamIdFor = async (name: string | null): Promise<string> => {
    if (!name) return defaultStreamId;
    const hit = streamIdCache.get(name);
    if (hit !== undefined) return hit;
    const id = await resolveStreamId(supabase, name);
    streamIdCache.set(name, id);
    return id;
  };

  for (const p of accepted) {
    // B20: standing boilerplate (a footer's "submit your boarding pass") is
    // never a task. The audit row records the phrase, never the mail.
    const phrase = matchesNeverExtract(p.title, p.note);
    if (phrase) {
      out.skipped += 1;
      out.neverExtract.push(phrase);
      continue;
    }
    if (isAlreadyOpen(p.title, openTitles)) {
      out.skipped += 1;
      out.notes.push(`${account.slot}: already on the list, "${p.title}"`);
      continue;
    }
    const mail = mailByRef.get(p.external_ref);
    const r = await createTask(supabase, userId, {
      title: p.title,
      notes: p.note,
      status: "inbox",
      due_ts: p.due_date ? dueAt930(p.due_date) : null,
      lapses_on: p.lapses_on,
      work_stream_id: await streamIdFor(p.work_stream),
      // A priority proposed from scanned mail is still the assistant's
      // judgment, never his: validateScanProposals has already dropped any
      // priority arriving without a reason.
      ...(p.priority ? { priority: p.priority, priority_reason: p.priority_reason } : {}),
      source: "email",
      external_ref: p.external_ref,
      external_thread: mail?.threadId ?? null,
      source_key: mail ? sourceKey(mail.from, mail.subject) : null,
    }, "assistant");
    if (!r.ok) {
      out.notes.push(`${account.slot}: ${r.message}`);
      continue;
    }
    // So two proposals in the same run cannot both land the same title.
    openTitles.push(p.title);
    out.created += 1;
    await supabase.from("assistant_actions").insert({
      user_id: userId,
      kind: "create_task",
      mode: "auto",
      status: "executed",
      account_id: account.id,
      title: `Task from mail: ${p.title}`.slice(0, 200),
      payload: p as unknown as Json,
      executed_at: new Date().toISOString(),
      result: { undo: { task_id: r.id } } as Json,
    });
  }
  return out;
}

async function resolveStreamId(
  supabase: Actor["supabase"],
  name: string
): Promise<string> {
  const { data } = await supabase.from("work_streams").select("id, name");
  const hit =
    data?.find((w) => w.name.toLowerCase() === name.toLowerCase()) ??
    data?.find((w) => w.name.toLowerCase() === "personal") ??
    data?.[0];
  if (!hit) throw new Error("No work streams exist.");
  return hit.id;
}

function dueAt930(dateOnly: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateOnly)!;
  return istInstant({ y: Number(m[1]), m: Number(m[2]), d: Number(m[3]) }, 9, 30).toISOString();
}
