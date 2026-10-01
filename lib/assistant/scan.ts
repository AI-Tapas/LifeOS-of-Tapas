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
// text and up to 3 PDF tickets, text extracted in memory and never stored)
// by a context whose one tool is propose_trip_leg,
// and a valid leg is written on its trip through the log_trip_leg performer.
// No PNR, city or mail text reaches an audit row: ids, counts and matched
// filter phrases only.
//
// B21 adds a third isolated turn, the cab receipt pass: mail from the cab
// receipt allowlist only (scan-filters.ts isCabReceiptSender), read by the
// same B20 reader, whose one tool is propose_cab_expense. A ride inside a trip
// becomes a billable transport expense through the add_trip_expense
// performer; a ride outside every trip is personal and only counted.

import { cookieActor, type Actor } from "@/lib/assistant/actor";
import { runLlmTurn, type LlmTurn, type LlmTurnRequest } from "@/lib/assistant/llm";
import type { LlmOverride } from "@/lib/assistant/config";
import { CAB_TOOL, SCAN_TOOL, TICKET_TOOL, disclosureOf } from "@/lib/assistant/tools";
import {
  CAB_SYSTEM,
  SCAN_SYSTEM,
  TICKET_SYSTEM,
  buildCabUserMessage,
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
import { readTicketMail } from "@/lib/assistant/mailbox";
import { pdfText } from "@/lib/assistant/pdf-text";
import {
  cabProviderOf,
  dropKnownMail,
  isAppGeneratedMail,
  isAlreadyOpen,
  isNoiseMail,
  isTicketSender,
  matchesNeverExtract,
  mayReadMailContent,
  sourceKey,
  type CabProvider,
} from "@/lib/assistant/scan-filters";
import { logScannedCabExpense, logScannedTripLeg } from "@/lib/assistant/execute";
import { CAB_RIDE_CAP, cabReceiptMail, priorFromPayload, validateCabProposals, type PriorCab } from "@/lib/trips/cab";
import {
  TICKET_LEG_CAP,
  routeFromName,
  validateTripLegProposals,
  type NoTripLeg,
} from "@/lib/trips/ticket";
import { createTask } from "@/lib/tasks/write";
import {
  classifyModelError,
  scanLimits,
  windowAlreadyClosed,
  type ScanLimits,
  type ScanOptions,
} from "@/lib/assistant/scan-args";
import { civilKey, civilToday, istInstant } from "@/lib/datetime";
import type { Json } from "@/lib/database.types";

// A6: proposals are capped per account per day (DAILY_TASK_CAP in
// scan-args.ts, five). B24: a hand-run catch-up over more than 3 days lifts
// that cap for that run only, through ScanLimits.task_cap.

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
  // B21: billable cab rides recorded from receipt mail.
  cabs: number;
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
// B24: the model turn, with one rule for a dead key. Every model pass goes
// through here; the first auth or provider error becomes a ScanModelError
// with a short fixed reason, and because nothing between here and the cron
// wrapper catches it, no later pass (and no later account) is attempted.
// The dead key is therefore tried once a night, not once per pass.
async function modelTurn(req: LlmTurnRequest): Promise<LlmTurn> {
  try {
    return await runLlmTurn(req);
  } catch (e) {
    throw classifyModelError(e);
  }
}

// options is B24's catch-up: the nightly cron passes none (3 days, 15
// messages a mailbox, 5 tasks an account, every account).
export async function runMailScan(actor?: Actor, options: ScanOptions = {}): Promise<ScanSummary> {
  const owner = actor ?? (await cookieActor());
  const { supabase } = owner;
  const limits = scanLimits(options.days);

  let accountQuery = supabase
    .from("accounts")
    .select("id, slot, provider, status, connect_mode, email")
    .eq("status", "connected")
    .eq("connect_mode", "direct");
  if (options.account) accountQuery = accountQuery.eq("slot", options.account);
  const { data: accounts } = await accountQuery;

  const summary: ScanSummary = { scanned: 0, created: 0, skipped: 0, legs: 0, cabs: 0, notes: [] };
  const override = await loadLlmOverride(supabase);
  // Trip legs have their own cap per run, across accounts, and do not count
  // against the daily task cap.
  let legBudget = TICKET_LEG_CAP;
  // B21: cab rides likewise, 20 a night across accounts.
  let cabBudget = CAB_RIDE_CAP;

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
          ? await listRecentGmail(account.id, limits)
          : await listRecentGraph(account.id, limits);
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

    const cabs = await cabPass(owner, acc, mails, refOf, cabBudget, override);
    cabBudget -= cabs.added.length;
    summary.cabs += cabs.added.length;
    summary.notes.push(...cabs.notes);

    // A ticket sender's mail never becomes a task (B20 amendment): the only
    // "action" in the travel desk's mail is its boarding-pass footer. The
    // never-extract phrase stays as the backstop for anything else. Nor does
    // a cab receipt sender's (B21).
    const tasks = await taskPass(
      owner,
      acc,
      mails.filter((m) => !mayReadMailContent(m.from)),
      refOf,
      override,
      limits
    );
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
        // Cities and a date only (the leg fields), never the PNR, so the
        // morning brief can say which ticket has no trip yet.
        tickets_without_trip: tickets.withoutTrip.length,
        tickets_without_trip_legs: tickets.withoutTrip.map(({ from, to, date }) => ({ from, to, date })),
        tickets_unreadable: tickets.unreadable.length,
        tickets_unreadable_routes: tickets.unreadable,
        ticket_pdfs_read: tickets.pdfsRead,
        ticket_pdfs_skipped: tickets.pdfsSkipped,
        ticket_rejected: tickets.rejected,
        // B21. Counts, amounts and the trip's own label only. A personal
        // ride is a number and nothing else.
        cab_receipts_read: cabs.read,
        cab_rides_added: cabs.added.length,
        cab_added_by_trip: cabs.byTrip,
        cab_rides_personal: cabs.personal,
        cab_receipts_unsplit: cabs.unsplit,
        cab_pdfs_read: cabs.pdfsRead,
        cab_rejected: cabs.rejected,
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
): Promise<{
  read: number;
  legs: number;
  withoutTrip: NoTripLeg[];
  unreadable: { from: string; to: string }[];
  pdfsRead: number;
  pdfsSkipped: number;
  rejected: string[];
  notes: string[];
}> {
  const { supabase, userId } = owner;
  const out = {
    read: 0,
    legs: 0,
    withoutTrip: [] as NoTripLeg[],
    unreadable: [] as { from: string; to: string }[],
    pdfsRead: 0,
    pdfsSkipped: 0,
    rejected: [] as string[],
    notes: [] as string[],
  };
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
  // Mails whose PDFs gave no text at all: the file name (or subject) is all
  // there is, and without a date no leg can be made.
  const noText = new Map<string, { from: string; to: string }>();
  for (const m of candidates) {
    try {
      const read = await readTicketMail(request, account, m, pdfText);
      out.pdfsRead += read.attachments.length;
      out.pdfsSkipped += read.skipped_too_big + read.skipped_over_limit;
      const attachments = read.attachments.map((a) => {
        const r = routeFromName(a.name);
        return { name: a.name, text: a.text, route: r ? `${r.from} to ${r.to}` : null };
      });
      const hadPdf = read.attachments.length + read.skipped_too_big > 0;
      if (hadPdf && !read.attachments.some((a) => a.text)) {
        const r = read.attachments.map((a) => routeFromName(a.name)).find(Boolean) ?? routeFromName(m.subject);
        noText.set(refOf(m.id), r ?? { from: "", to: "" });
      }
      ticketMails.push({
        ref: refOf(m.id),
        from: m.from,
        subject: m.subject,
        date: m.date,
        body: read.body,
        attachments,
      });
    } catch {
      out.notes.push(`${account.slot}: could not read one ticket email`);
    }
  }
  out.read = ticketMails.length;
  if (!ticketMails.length) return out;

  const { data: trips } = await supabase
    .from("trips")
    .select("id, start_date, end_date, legs, status, session_date, cities")
    .eq("user_id", userId)
    .neq("status", "cancelled")
    .not("start_date", "is", null)
    // B28: a stable order, so overlapping sessions match the same way every run.
    .order("start_date", { ascending: true })
    .order("id", { ascending: true });

  const turn = await modelTurn({
    blocks: [{ text: TICKET_SYSTEM, stable: true }],
    conv: [{ kind: "text", role: "user", text: buildTicketUserMessage(ticketMails) }],
    tools: [TICKET_TOOL],
    // Several tickets an email, one call each: room for the nightly cap.
    maxTokens: 2048,
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
  out.withoutTrip = withoutTrip;
  for (const [ref, route] of noText) {
    const placed = accepted.some((a) => a.external_ref === ref) || withoutTrip.some((w) => w.ref === ref);
    if (!placed) out.unreadable.push(route);
  }
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
  if (out.withoutTrip.length) {
    out.notes.push(
      `${account.slot}: ${out.withoutTrip.length} ${out.withoutTrip.length === 1 ? "ticket has" : "tickets have"} no trip yet`
    );
  }
  if (out.unreadable.length) {
    out.notes.push(
      `${account.slot}: ${out.unreadable.length} ticket ${out.unreadable.length === 1 ? "email" : "emails"} could not be read`
    );
  }
  return out;
}

// ---------------------------------------------------------------------------
// B21. The cab receipt pass.
// ---------------------------------------------------------------------------
async function cabPass(
  owner: Actor,
  account: ScanAccount,
  mails: MailMeta[],
  refOf: (id: string) => string,
  budget: number,
  override: LlmOverride | undefined
): Promise<{
  read: number;
  added: { trip_id: string; label: string; amount: number }[];
  byTrip: { label: string; count: number; amount: number }[];
  personal: number;
  unsplit: number;
  pdfsRead: number;
  rejected: string[];
  notes: string[];
}> {
  const { supabase, userId } = owner;
  const out = {
    read: 0,
    added: [] as { trip_id: string; label: string; amount: number }[],
    byTrip: [] as { label: string; count: number; amount: number }[],
    personal: 0,
    unsplit: 0,
    pdfsRead: 0,
    rejected: [] as string[],
    notes: [] as string[],
  };
  let candidates = mails.filter((m) => cabProviderOf(m.from) !== null);
  if (!candidates.length || budget <= 0) return out;

  // A receipt already recorded (or recorded and undone) is not read again,
  // and every earlier scanned ride feeds the duplicate check.
  // ponytail: a Bharat Taxi invoice cut short by the nightly cap is not
  // re-read either; the cap of 20 is far above a night of his receipts.
  const { data: done } = await supabase
    .from("assistant_actions")
    .select("payload")
    .eq("user_id", userId)
    .eq("kind", "add_trip_expense")
    .eq("payload->>via", "cab_receipt");
  const prior: PriorCab[] = [];
  const logged = new Set<string>();
  for (const r of done ?? []) {
    const p = (r.payload ?? {}) as Record<string, unknown>;
    if (typeof p.external_ref === "string") logged.add(p.external_ref);
    const x = priorFromPayload(p);
    if (x) prior.push(x);
  }
  candidates = candidates.filter((m) => !logged.has(refOf(m.id)));
  if (!candidates.length) return out;

  const request = mailRequest(account.id);
  const receiptMails: TicketMail[] = [];
  const senders = new Map<string, CabProvider>();
  for (const m of candidates) {
    try {
      const read = await readTicketMail(request, account, m, pdfText);
      out.pdfsRead += read.attachments.length;
      receiptMails.push(cabReceiptMail({ ref: refOf(m.id), from: m.from, subject: m.subject, date: m.date }, read));
      senders.set(refOf(m.id), cabProviderOf(m.from)!);
    } catch {
      out.notes.push(`${account.slot}: could not read one cab receipt email`);
    }
  }
  out.read = receiptMails.length;
  if (!receiptMails.length) return out;

  const { data: trips } = await supabase
    .from("trips")
    .select("id, title, cities, start_date, end_date, legs, status, session_date")
    .eq("user_id", userId)
    .neq("status", "cancelled")
    .not("start_date", "is", null)
    // B28: a stable order, so overlapping sessions match the same way every run.
    .order("start_date", { ascending: true })
    .order("id", { ascending: true });

  const turn = await modelTurn({
    blocks: [{ text: CAB_SYSTEM, stable: true }],
    conv: [{ kind: "text", role: "user", text: buildCabUserMessage(receiptMails) }],
    tools: [CAB_TOOL],
    // An invoice can list many rides, one call each: room for the cap.
    maxTokens: 4096,
    override,
  });
  if (turn.stop === "refusal") {
    out.notes.push(`${account.slot}: the model declined the cab receipt pass`);
    return out;
  }
  const { accepted, rejected, personal, wellFormedRefs } = validateCabProposals(
    turn.calls.map((c): RawToolCall => ({ name: c.name, input: c.input })),
    senders,
    trips ?? [],
    prior,
    budget
  );
  out.rejected = rejected;
  out.personal = personal;
  // A Bharat Taxi invoice that gave no well-formed ride could not be split.
  for (const [ref, provider] of senders) {
    if (provider === "bharat_taxi" && !wellFormedRefs.has(ref)) out.unsplit += 1;
  }
  for (const r of accepted) {
    try {
      await logScannedCabExpense(owner, r, account.id);
      out.added.push({ trip_id: r.trip_id, label: r.trip_label, amount: r.amount });
    } catch (e) {
      out.notes.push(`${account.slot}: ${e instanceof Error ? e.message : "could not record a cab ride"}`);
    }
  }
  const byTrip = new Map<string, { label: string; count: number; amount: number }>();
  for (const a of out.added) {
    const cur = byTrip.get(a.trip_id) ?? { label: a.label, count: 0, amount: 0 };
    byTrip.set(a.trip_id, { label: a.label, count: cur.count + 1, amount: cur.amount + a.amount });
  }
  out.byTrip = [...byTrip.values()];
  if (out.added.length) {
    out.notes.push(
      `${account.slot}: recorded ${out.added.length} billable cab ${out.added.length === 1 ? "ride" : "rides"} from receipts`
    );
  }
  if (out.unsplit) {
    out.notes.push(
      `${account.slot}: ${out.unsplit} Bharat Taxi ${out.unsplit === 1 ? "receipt" : "receipts"} could not be split into rides`
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
  override: LlmOverride | undefined,
  limits: ScanLimits
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
  const budget = Math.max(0, limits.task_cap - (count ?? 0));
  if (!budget) {
    out.notes.push(`${account.slot}: daily cap of ${limits.task_cap} reached`);
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
  const turn = await modelTurn({
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

  const todayKey = civilKey(civilToday());
  for (const p of accepted) {
    // B20: standing boilerplate (a footer's "submit your boarding pass") is
    // never a task. The audit row records the phrase, never the mail.
    const phrase = matchesNeverExtract(p.title, p.note);
    if (phrase) {
      out.skipped += 1;
      out.neverExtract.push(phrase);
      continue;
    }
    // B24: a window that closed before today is not worth a task; the 7 AM
    // sweep would only drop it later.
    if (windowAlreadyClosed(p.lapses_on, todayKey)) {
      out.skipped += 1;
      out.notes.push(`${account.slot}: skipped one email whose window had already closed`);
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
