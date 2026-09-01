// On-demand mail-to-task. Pipeline isolation (attack A1): each account is
// scanned in its OWN model context whose tool set is exactly one tool,
// propose_task. No send, draft, calendar or person tool exists in that
// context; validateScanProposals discards anything else the model emits, and
// external_ref must match a scanned message, so provenance cannot be forged.
// Bodies are never stored: tasks carry a short title, a short note and the
// message ref only (attack A2).

import { cookieActor, type Actor } from "@/lib/assistant/actor";
import { runLlmTurn } from "@/lib/assistant/llm";
import { SCAN_TOOL } from "@/lib/assistant/tools";
import {
  SCAN_SYSTEM,
  buildScanUserMessage,
  type ScanMail,
} from "@/lib/assistant/prompt";
import {
  validateScanProposals,
  isCalendarInvite,
  type RawToolCall,
} from "@/lib/assistant/core";
import { loadLlmOverride } from "@/lib/assistant/settings";
import { listRecentGmail, listRecentGraph } from "@/lib/assistant/mail";
import { isAppGeneratedMail, isAlreadyOpen } from "@/lib/assistant/scan-filters";
import { createTask } from "@/lib/tasks/write";
import { istInstant } from "@/lib/datetime";
import type { Json } from "@/lib/database.types";

// A6: proposals are capped per account per day so a mailbox flood cannot
// bury the task list.
const DAILY_CAP = 20;

export interface ScanSummary {
  scanned: number;
  created: number;
  skipped: number;
  notes: string[];
}

// Slot -> work stream the scanner files tasks under.
const SLOT_STREAM: Record<string, string> = {
  taxstrategia: "Tax Strategia",
  ca_tapasnr: "Personal",
  altechon: "Altechon",
  icai: "ICAI",
};

// The actor is passed in so this runs identically for the signed-in owner in
// the app and for the MCP connector, which has no cookie and arrives with the
// service actor instead. Writing tasks through lib/tasks/write rather than the
// "use server" action keeps this off the server-action path entirely.
export async function runMailScan(actor?: Actor): Promise<ScanSummary> {
  const { supabase, userId } = actor ?? (await cookieActor());

  const { data: accounts } = await supabase
    .from("accounts")
    .select("id, slot, provider, status, connect_mode, email")
    .eq("status", "connected")
    .eq("connect_mode", "direct");

  const summary: ScanSummary = { scanned: 0, created: 0, skipped: 0, notes: [] };
  const override = await loadLlmOverride(supabase, "scan");

  for (const account of accounts ?? []) {
    if (!account.slot) continue;
    let mails;
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
    if (!mails.length) continue;

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
    if (!mails.length) continue;

    const refOf = (id: string) => `${account.provider === "google" ? "gmail" : "graph"}:${account.slot}:${id}`;
    const scanMails: ScanMail[] = mails.map((m) => ({
      ref: refOf(m.id),
      account: account.slot!,
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
    if (!knownRefs.size) continue;

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
      summary.notes.push(`${account.slot}: daily cap of ${DAILY_CAP} reached`);
      continue;
    }

    // The real stream names, so a proposal can file itself correctly and the
    // answer can be checked against this exact list rather than trusted.
    const { data: streamRows } = await supabase
      .from("work_streams")
      .select("name")
      .eq("user_id", userId)
      .eq("active", true);
    const streamNames = (streamRows ?? []).map((s) => s.name);

    // Isolated scanner context: one tool, no persona, mail fenced as data.
    const turn = await runLlmTurn({
      blocks: [{ text: SCAN_SYSTEM, stable: true }],
      conv: [
        { kind: "text", role: "user", text: buildScanUserMessage(scanMails, streamNames) },
      ],
      tools: [SCAN_TOOL],
      maxTokens: 2048,
      override,
    });
    if (turn.stop === "refusal") {
      summary.notes.push(`${account.slot}: the model declined the scan`);
      continue;
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
    summary.skipped += rejected.length;

    // The mailbox a message arrives in is only the fallback. A proposal that
    // named one of his real streams wins, because a household bill landing in
    // a work account is still personal.
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

    // Second belt, on meaning rather than message id: two AWS budget alerts,
    // or two chasers on one thread, are different messages saying the same
    // thing, so external_ref alone lets both through. Compare against what is
    // already open (done and dropped tasks do not block a genuine repeat).
    const { data: openRows } = await supabase
      .from("tasks")
      .select("title")
      .eq("user_id", userId)
      .in("status", ["inbox", "todo", "doing"]);
    const openTitles = (openRows ?? []).map((r) => r.title);

    for (const p of accepted) {
      if (isAlreadyOpen(p.title, openTitles)) {
        summary.skipped += 1;
        summary.notes.push(`${account.slot}: already on the list, "${p.title}"`);
        continue;
      }
      const r = await createTask(supabase, userId, {
        title: p.title,
        notes: p.note,
        status: "inbox",
        due_ts: p.due_date ? dueAt930(p.due_date) : null,
        work_stream_id: await streamIdFor(p.work_stream),
        source: "email",
        external_ref: p.external_ref,
      });
      if (!r.ok) {
        summary.notes.push(`${account.slot}: ${r.message}`);
        continue;
      }
      // So two proposals in the same run cannot both land the same title.
      openTitles.push(p.title);
      summary.created += 1;
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
    await supabase.from("audit_log").insert({
      user_id: userId,
      actor: "assistant",
      action: "mail_scan",
      entity: "accounts",
      entity_id: account.id,
      meta: {
        slot: account.slot,
        scanned: mails.length,
        proposed: accepted.length,
        rejected,
      } as Json,
    });
  }
  return summary;
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
