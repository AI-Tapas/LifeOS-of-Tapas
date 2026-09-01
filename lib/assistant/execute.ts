// Server-side tool execution. The autonomy buckets live in code here:
//   autonomous -> perform now, record an executed assistant_action (undoable)
//   confirm    -> insert a proposed assistant_action; NOTHING is performed
//   stub       -> fixed string, no side effect
// plus the approved-queue executor (the only code path that ever sends mail
// or writes an attendee-bearing event) and undo. All rows are written through
// the owner's authenticated Supabase client, so RLS and the DB triggers
// apply; only the provider calls use the service-role path inside
// withResourceAuth.

import { AsyncLocalStorage } from "node:async_hooks";
import { cookieActor, type Actor } from "@/lib/assistant/actor";
import { withResourceAuth } from "@/lib/oauth/tokens";
import { createEvent, updateEvent, deleteAppEvent } from "@/lib/events/write";
import {
  istInstant,
  istCivil,
  istHour,
  istMinute,
  formatDateIST,
} from "@/lib/datetime";
import {
  createTask,
  updateTask,
  deleteTask,
  type TaskInput,
} from "@/lib/tasks/write";
import {
  addTripExpense,
  addTripLeg,
  createTrip,
  deleteTrip,
  deleteTripExpense,
  updateTrip,
} from "@/lib/trips/write";
import { TRANSPORT_MODES, type TransportMode, type TripLeg } from "@/lib/trips/core";
import { HOTEL_ARRANGEMENTS, type HotelArrangement } from "@/lib/trips/checklist";
import { isFinanceKeyDateType, isReminderMode } from "@/lib/reminders/core";
import {
  AUTONOMOUS_KINDS,
  STUB_REPLIES,
  SEND_CLASS,
  assertNoAttendees,
  disclosureOf,
  routeTool,
  TOOL_TARGETS,
  type ToolTarget,
} from "./tools";
import {
  checkDisclosure,
  hashPayload,
  provenance,
  runApprovedExecution,
  runAutonomousAction,
  type Provenance,
} from "./core";
import {
  removeFinanceReminder,
  removeObligationReminder,
  syncFinanceReminder,
  syncObligationReminder,
  syncTaskReminder,
} from "@/lib/reminders/writer";
import type { Database, Json } from "@/lib/database.types";
import type { SupabaseClient } from "@supabase/supabase-js";

type Db = SupabaseClient<Database>;

// Every entry point takes an optional actor: the browser passes none and gets
// its cookie session, the MCP route passes a token-authenticated service
// actor. The gates below behave identically either way.
async function ownerClient(actor?: Actor): Promise<Actor> {
  return actor ?? cookieActor();
}

// B12. Provenance is a required argument, not an optional extra: an assistant
// audit row that does not say why the action was permitted is the gap this
// closes, so the compiler refuses to write one rather than a convention asking
// people not to.
async function audit(
  supabase: Db,
  userId: string,
  action: string,
  entityId: string | null,
  meta: Record<string, unknown>,
  prov: Provenance
): Promise<void> {
  await supabase.from("audit_log").insert({
    user_id: userId,
    actor: "assistant",
    action,
    entity: "assistant_actions",
    entity_id: entityId,
    meta: { ...meta, provenance: prov } as unknown as Json,
  });
}

// The provenance every assistant audit row carries. One wrapper over the
// core builder, so an actor and a tool name are all a call site needs and no
// two of them can disagree about the shape.
function prov(
  owner: Actor,
  basis: Parameters<typeof provenance>[0]["basis"],
  tool: string,
  actionId: string | null,
  payloadHash: string | null = null
): Provenance {
  return provenance({
    basis,
    tool,
    disclosure: disclosureOf(tool),
    actorOrigin: owner.origin,
    actionId,
    payloadHash,
    originatingJob: owner.job,
  });
}

// ---------------------------------------------------------------------------
// Shared payload helpers
// ---------------------------------------------------------------------------
function s(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

// The model's word for how the hotel is arranged, checked against the enum
// here rather than trusted. Anything unrecognised becomes null, which reads
// as his norm instead of writing a value he never chose.
function hotelArrangement(v: unknown): HotelArrangement | null {
  const raw = s(v);
  return raw && (HOTEL_ARRANGEMENTS as string[]).includes(raw)
    ? (raw as HotelArrangement)
    : null;
}

function civil(dateOnly: string): { y: number; m: number; d: number } {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateOnly);
  if (!m) throw new Error(`Invalid date: ${dateOnly}`);
  return { y: Number(m[1]), m: Number(m[2]), d: Number(m[3]) };
}

function hm(time: string): { h: number; m: number } {
  const m = /^(\d{1,2}):(\d{2})$/.exec(time);
  if (!m) throw new Error(`Invalid time: ${time}`);
  return { h: Number(m[1]), m: Number(m[2]) };
}

// The IST wall clock of a stored instant, for edits that change only part of
// an event.
function istCivilOf(iso: string): { y: number; m: number; d: number } {
  const c = istCivil(iso);
  return { y: c.y, m: c.m, d: c.d };
}

function istHourOf(iso: string): number {
  return istHour(iso);
}

function istMinuteOf(iso: string): number {
  return istMinute(iso);
}

// Task due dates land at 9:30 am IST on the given day, matching when the
// reminder popups are most useful.
function dueIso(dateOnly: string): string {
  return istInstant(civil(dateOnly), 9, 30).toISOString();
}

// Never change a priority quietly. When one is set, the reply says so and
// says why, in the same words that are written to the task and shown on the
// row, so the chat and the screen cannot disagree.
function priorityLine(
  priority: string | null | undefined,
  reason: string | null | undefined
): string {
  if (!priority) return "";
  return reason
    ? ` Priority ${priority}: ${reason}.`
    : ` Priority ${priority}.`;
}

async function resolveWorkStream(
  supabase: Db,
  name: string | null
): Promise<string> {
  const { data: streams } = await supabase
    .from("work_streams")
    .select("id, name")
    .order("name");
  if (!streams?.length) throw new Error("No work streams exist.");
  const wanted = (name ?? "personal").trim().toLowerCase();
  const hit =
    streams.find((w) => w.name.toLowerCase() === wanted) ??
    streams.find((w) => w.name.toLowerCase() === "personal") ??
    streams[0];
  return hit.id;
}

async function resolveAccount(
  supabase: Db,
  slot: string
): Promise<{ id: string; email: string; slot: string; provider: string }> {
  const { data } = await supabase
    .from("accounts")
    .select("id, email, slot, provider, status, connect_mode")
    .eq("slot", slot)
    .maybeSingle();
  if (!data) throw new Error(`The ${slot} account is not connected.`);
  if (data.status !== "connected" || data.connect_mode !== "direct") {
    throw new Error(`The ${slot} account is ${data.status}.`);
  }
  return { id: data.id, email: data.email, slot, provider: data.provider };
}

function asEmailList(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const item of v) {
    const e = typeof item === "string" ? item.trim() : "";
    // Minimal shape check; the confirmation UI shows the raw address either way.
    if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) out.push(e);
    else if (e) throw new Error(`Not a valid email address: ${e}`);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Tool dispatch for the chat loop
// ---------------------------------------------------------------------------
export interface ToolOutcome {
  // What the model sees as the tool result.
  reply: string;
  // Set when a queue item was created or executed, for the UI notice line.
  actionId?: string;
  queued?: boolean;
}

// Set for the whole of one tool's execution, so a tool that reaches back into
// executeToolCall is visibly nested. AsyncLocalStorage rather than a module
// counter: the nightly scan and a chat turn can be in flight at the same time,
// and a counter would mistake one for the other.
const insideTool = new AsyncLocalStorage<true>();

export async function executeToolCall(
  name: string,
  input: Record<string, unknown>,
  actor?: Actor
): Promise<ToolOutcome> {
  // Disclosure comes before anything else, including the stub shortcut: what a
  // tool may SEE is decided before we look at what it may do.
  const gate = checkDisclosure(disclosureOf(name), insideTool.getStore() === true);
  if (!gate.ok) throw new Error(gate.message);
  return insideTool.run(true, () => dispatchToolCall(name, input, actor));
}

// B11: the route comes from routeTool, which takes a name and nothing else.
// Nothing in this function may read actor.origin: an unattended caller has to
// land in exactly the same branch as the browser, and the way to keep that
// true is to give the decision nothing else to read.
async function dispatchToolCall(
  name: string,
  input: Record<string, unknown>,
  actor?: Actor
): Promise<ToolOutcome> {
  const route = routeTool(name);
  if (route === "stub") {
    return { reply: STUB_REPLIES[name] ?? "Not available yet." };
  }
  if (route === "unknown") return { reply: `Unknown tool: ${name}.` };

  const owner = await ownerClient(actor);
  return route === "propose"
    ? proposeAction(owner, name, input)
    : performAutonomous(owner, name, input);
}

// Anything that would notify a third party lands as a proposed action. The
// model's draft_email also lands here: the draft IS the proposed send_email
// row, stored only in the app database (attack A8: no Gmail/Outlook drafts).
async function proposeAction(
  owner: Actor,
  name: string,
  input: Record<string, unknown>
): Promise<ToolOutcome> {
  const { supabase, userId } = owner;
  const kind = name === "draft_email" ? "send_email" : name;
  if (!SEND_CLASS.has(kind)) throw new Error(`${name} cannot be proposed.`);

  const slot = s(input.account);
  if (!slot) throw new Error("An account slot is required.");
  const account = await resolveAccount(supabase, slot);

  let title: string;
  let payload: Record<string, unknown>;
  if (kind === "send_email") {
    const to = asEmailList(input.to);
    if (!to.length) throw new Error("At least one valid recipient is required.");
    const cc = asEmailList(input.cc ?? []);
    const subject = s(input.subject) ?? "";
    const body = typeof input.body === "string" ? input.body : "";
    if (!subject || !body.trim()) throw new Error("Subject and body are required.");
    payload = { account_id: account.id, account_slot: slot, to, cc, subject, body };
    title = `Email to ${to.join(", ")}: ${subject}`.slice(0, 200);
  } else {
    // propose_event_with_invites
    const attendeesRaw = Array.isArray(input.attendees) ? input.attendees : [];
    const attendees = attendeesRaw.map((a) => {
      const rec = (a ?? {}) as Record<string, unknown>;
      const email = asEmailList([rec.email])[0];
      if (!email) throw new Error("Every attendee needs a valid email address.");
      return { email, name: s(rec.name) ?? undefined };
    });
    if (!attendees.length) {
      throw new Error("propose_event_with_invites needs at least one attendee. For a solo event use add_event_solo.");
    }
    const date = s(input.date);
    const eventTitle = s(input.title);
    if (!date || !eventTitle) throw new Error("A title and date are required.");
    payload = {
      account_id: account.id,
      account_slot: slot,
      title: eventTitle,
      date,
      start_time: s(input.start_time),
      end_time: s(input.end_time),
      description: s(input.description),
      location: s(input.location),
      attendees,
    };
    title = `Invite ${attendees.map((a) => a.email).join(", ")}: ${eventTitle}`.slice(0, 200);
  }

  const { data, error } = await supabase
    .from("assistant_actions")
    .insert({
      user_id: userId,
      kind,
      mode: "draft",
      status: "proposed",
      account_id: account.id,
      title,
      payload: payload as Json,
    })
    .select("id")
    .single();
  if (error || !data) throw new Error(error?.message ?? "Could not queue the action.");
  await audit(
    supabase,
    userId,
    "propose",
    data.id,
    { kind, account_slot: slot, via: name },
    // Nothing was performed and nothing was approved: the confirm bucket is
    // the whole reason this exists as a row rather than as an act.
    prov(owner, "confirm_bucket", name, data.id)
  );
  return {
    reply:
      kind === "send_email"
        ? `Draft stored and queued for approval (action ${data.id}). It will not be sent until Tapas approves it in the Assistant queue.`
        : `Invite proposal queued for approval (action ${data.id}). No invitation goes out until Tapas approves it.`,
    actionId: data.id,
    queued: true,
  };
}

// ---------------------------------------------------------------------------
// Autonomous kinds: perform now, record an executed action with undo info.
// ---------------------------------------------------------------------------
interface Performed {
  summary: string;
  undo: Record<string, unknown> | null;
  accountId?: string;
}

// ponytail: this re-reads a row most performers read again for their undo
// payload. One extra select on a single-user app is cheaper than threading the
// row through every performer signature, and holding the gate in one place is
// the whole point of the control.
async function targetResolves(
  supabase: Db,
  userId: string,
  spec: ToolTarget,
  value: string
): Promise<boolean> {
  if (!spec.table) {
    // An account slot resolves only when that account is connected directly.
    try {
      await resolveAccount(supabase, value);
      return true;
    } catch {
      return false;
    }
  }
  // user_id is scoped explicitly: the service actor bypasses RLS, so the row
  // is proved the owner's here rather than assumed. A malformed id makes
  // Postgres refuse the comparison, which lands as "not found" as well.
  const { data } = await supabase
    .from(spec.table)
    .select("id")
    .eq("id", value)
    .eq("user_id", userId)
    .maybeSingle();
  return !!data;
}

// The proposed row a downgrade lands as. No account is bound to it and nothing
// was performed; the reason is the title, which is what the queue card shows.
async function downgradeToQueue(
  supabase: Db,
  userId: string,
  name: string,
  input: Record<string, unknown>,
  reason: string
): Promise<{ actionId: string }> {
  const { data, error } = await supabase
    .from("assistant_actions")
    .insert({
      user_id: userId,
      kind: name,
      mode: "draft",
      status: "proposed",
      title: reason.slice(0, 200),
      payload: input as Json,
    })
    .select("id")
    .single();
  if (error || !data) {
    throw new Error(error?.message ?? "Could not queue the action.");
  }
  return { actionId: data.id };
}

async function performAutonomous(
  owner: Actor,
  name: string,
  input: Record<string, unknown>
): Promise<ToolOutcome> {
  const { supabase, userId } = owner;
  if (!AUTONOMOUS_KINDS.has(name)) {
    throw new Error(`${name} is not an autonomous tool.`);
  }
  const spec = TOOL_TARGETS[name];
  const outcome = await runAutonomousAction<Performed>(input, spec, {
    resolveTarget: (value) => targetResolves(supabase, userId, spec, value),
    perform: () => performers[name](supabase, userId, input, owner),
    recordExecuted: async (done) => {
      const { data } = await supabase
        .from("assistant_actions")
        .insert({
          user_id: userId,
          kind: name,
          mode: "auto",
          status: "executed",
          account_id: done.accountId ?? null,
          title: done.summary.slice(0, 200),
          payload: input as Json,
          payload_hash: hashPayload(input),
          executed_at: new Date().toISOString(),
          result: { undo: done.undo } as Json,
        })
        .select("id")
        .single();
      return { actionId: data?.id ?? null };
    },
    downgrade: (reason) => downgradeToQueue(supabase, userId, name, input, reason),
  });

  if (outcome.basis === "downgraded_to_queue") {
    await audit(
      supabase,
      userId,
      "downgrade_to_queue",
      outcome.actionId,
      { kind: name, reason: outcome.reason },
      prov(owner, "downgraded_to_queue", name, outcome.actionId)
    );
    return {
      reply:
        outcome.reason +
        ` It is in the approval queue as action ${outcome.actionId} for Tapas to see.` +
        " Check the id and ask again if you have a better one.",
      actionId: outcome.actionId,
      queued: true,
    };
  }
  await audit(
    supabase,
    userId,
    "execute_autonomous",
    outcome.actionId,
    { kind: name },
    prov(owner, "autonomous_bucket", name, outcome.actionId)
  );
  return { reply: outcome.done.summary, actionId: outcome.actionId ?? undefined };
}

// The actor is passed to every performer and used by the three that re-enter
// the assistant (the scan, undo, reject), so an unattended call stays labelled
// unattended all the way down. It is carried for the record, never consulted
// for permission: routeTool settled the bucket before any of this ran.
type Performer = (
  supabase: Db,
  userId: string,
  input: Record<string, unknown>,
  owner: Actor
) => Promise<Performed>;

const performers: Record<string, Performer> = {
  async create_task(supabase, _userId, input) {
    // _userId is the acting owner; see lib/assistant/actor.ts.
    const title = s(input.title);
    if (!title) throw new Error("A task title is required.");
    const workStreamId = await resolveWorkStream(supabase, s(input.work_stream));
    const due = s(input.due_date);
    const priority = s(input.priority) as TaskInput["priority"] | null;
    const r = await createTask(supabase, _userId, {
      title,
      notes: s(input.note),
      status: "todo",
      // Left out entirely when the model named no priority, so the row takes
      // the default and stays visibly unrated rather than silently "medium,
      // decided". A priority WITH no reason is refused inside createTask.
      ...(priority ? { priority } : {}),
      priority_reason: s(input.priority_reason),
      due_ts: due ? dueIso(due) : null,
      work_stream_id: workStreamId,
      // A trip id attaches the task as a checklist step, so it rolls up under
      // the trip instead of standing on its own in every ranked list.
      trip_id: s(input.trip_id),
      // Validated here, never trusted from the wire: anything but the two
      // real values is dropped and the row takes the 'calendar' default.
      ...(isReminderMode(input.reminder_mode)
        ? { reminder_mode: input.reminder_mode }
        : {}),
      is_billable: input.billable === true,
      source: "assistant",
    }, "assistant");
    if (!r.ok) throw new Error(r.message);
    return {
      summary:
        `Task created: ${title}${due ? `, due ${formatDateIST(dueIso(due))}` : ""}.` +
        priorityLine(priority, s(input.priority_reason)),
      undo: { task_id: r.id },
    };
  },

  async update_task(supabase, _userId, input) {
    const taskId = s(input.task_id);
    if (!taskId) throw new Error("task_id is required.");
    const { data: prev } = await supabase
      .from("tasks")
      .select(
        "title, notes, status, priority, priority_source, priority_reason, due_ts, remind_offsets, reminder_mode, trip_id"
      )
      .eq("id", taskId)
      .single();
    if (!prev) throw new Error("Task not found.");
    const patch: Partial<TaskInput> = {};
    if (s(input.title)) patch.title = s(input.title)!;
    if (input.note !== null && input.note !== undefined) patch.notes = s(input.note);
    if (s(input.status)) patch.status = s(input.status) as TaskInput["status"];
    if (s(input.priority)) patch.priority = s(input.priority) as TaskInput["priority"];
    if (s(input.priority_reason)) patch.priority_reason = s(input.priority_reason);
    if (s(input.due_date)) patch.due_ts = dueIso(s(input.due_date)!);
    if (s(input.trip_id)) patch.trip_id = s(input.trip_id);
    if (isReminderMode(input.reminder_mode)) patch.reminder_mode = input.reminder_mode;
    const r = await updateTask(supabase, _userId, taskId, patch, "assistant");
    if (!r.ok) throw new Error(r.message);
    return {
      // r.priorityNote appears when the row already carried his own rating:
      // the rest of the update landed, the priority did not, and the reply
      // says so rather than claiming a change that never happened.
      summary:
        `Task updated: ${patch.title ?? prev.title}.` +
        (r.priorityNote
          ? ` ${r.priorityNote}`
          : priorityLine(patch.priority ?? null, patch.priority_reason ?? null)),
      undo: { task_id: taskId, prev },
    };
  },

  async set_reminder(supabase, _userId, input) {
    const taskId = s(input.task_id);
    const due = s(input.due_date);
    if (!taskId || !due) throw new Error("task_id and due_date are required.");
    const { data: prev } = await supabase
      .from("tasks")
      .select("title, notes, status, priority, priority_source, priority_reason, due_ts, remind_offsets, reminder_mode")
      .eq("id", taskId)
      .single();
    if (!prev) throw new Error("Task not found.");
    const offsets = Array.isArray(input.remind_days)
      ? (input.remind_days as number[]).filter((n) => Number.isInteger(n) && n >= 0)
      : undefined;
    const r = await updateTask(supabase, _userId, taskId, {
      due_ts: dueIso(due),
      ...(offsets ? { remind_offsets: offsets } : {}),
    }, "assistant");
    if (!r.ok) throw new Error(r.message);
    return {
      summary: `Reminder set on "${prev.title}" for ${formatDateIST(dueIso(due))}${
        r.reminderNote ? ` (${r.reminderNote})` : ""
      }.`,
      undo: { task_id: taskId, prev },
    };
  },

  async add_note(supabase, userId, input) {
    const title = s(input.title);
    const type = s(input.type);
    if (!title || !type) throw new Error("A note needs a type and title.");
    const { data, error } = await supabase
      .from("notes")
      .insert({
        user_id: userId,
        type: type as Database["public"]["Enums"]["note_type"],
        title,
        body_md: s(input.body),
      })
      .select("id")
      .single();
    if (error || !data) throw new Error(error?.message ?? "Could not save the note.");
    return { summary: `Note saved: ${title}.`, undo: { note_id: data.id } };
  },

  async add_person(supabase, userId, input) {
    const name = s(input.name);
    if (!name) throw new Error("A name is required.");
    const email = s(input.email);
    const phone = s(input.phone);
    const { data, error } = await supabase
      .from("people")
      .insert({
        user_id: userId,
        name,
        org: s(input.org),
        role: s(input.role),
        emails: email ? [email.toLowerCase()] : [],
        phones: phone ? [phone] : [],
        context_md: s(input.context),
        // A5: assistant-created people stay unverified until Tapas confirms
        // them; the send-confirmation UI highlights unverified recipients.
        unverified: true,
      })
      .select("id")
      .single();
    if (error || !data) throw new Error(error?.message ?? "Could not save the person.");
    return {
      summary: `Person saved (unverified until you confirm): ${name}.`,
      undo: { person_id: data.id },
    };
  },

  async add_obligation(supabase, userId, input) {
    const name = s(input.name);
    const category = s(input.category);
    const frequency = s(input.frequency);
    const dueDay = Number(input.due_day);
    if (!name || !category || !frequency || !Number.isInteger(dueDay)) {
      throw new Error("Name, category, frequency and due_day are required.");
    }
    const { data, error } = await supabase
      .from("recurring_obligations")
      .insert({
        user_id: userId,
        name,
        category: category as Database["public"]["Enums"]["obligation_category"],
        amount: typeof input.amount === "number" ? input.amount : null,
        variable_amount: typeof input.amount !== "number",
        frequency: frequency as Database["public"]["Enums"]["obligation_frequency"],
        due_day: dueDay,
        due_month: typeof input.due_month === "number" ? input.due_month : null,
        autopay: input.autopay === true,
      })
      .select("id")
      .single();
    if (error || !data) throw new Error(error?.message ?? "Could not save it.");
    return { summary: `Obligation added: ${name}.`, undo: { obligation_id: data.id } };
  },


  // --- housekeeping on Tapas's own records ---------------------------------
  // Deleting his own rows is his business; nothing here touches data the app
  // did not create. The calendar case is the exception that proves it:
  // delete_event routes through deleteAppEvent, which refuses a synced event.

  async delete_task(supabase, userId, input) {
    const taskId = s(input.task_id);
    if (!taskId) throw new Error("task_id is required.");
    const { data: row } = await supabase
      .from("tasks")
      .select("*")
      .eq("id", taskId)
      .single();
    if (!row) throw new Error("Task not found.");
    const r = await deleteTask(supabase, userId, taskId);
    if (!r.ok) throw new Error(r.message ?? "Could not delete the task.");
    return { summary: `Task deleted: ${row.title}.`, undo: { row } };
  },

  async add_project(supabase, userId, input) {
    const name = s(input.name);
    if (!name) throw new Error("A project name is required.");
    const workStreamId = await resolveWorkStream(supabase, s(input.work_stream));
    const { data, error } = await supabase
      .from("projects")
      .insert({
        user_id: userId,
        name,
        work_stream_id: workStreamId,
        notes: s(input.notes),
      })
      .select("id")
      .single();
    if (error || !data) throw new Error(error?.message ?? "Could not save the project.");
    return { summary: `Project created: ${name}.`, undo: { project_id: data.id } };
  },

  async update_note(supabase, _userId, input) {
    const noteId = s(input.note_id);
    if (!noteId) throw new Error("note_id is required.");
    const { data: prev } = await supabase
      .from("notes")
      .select("title, body_md")
      .eq("id", noteId)
      .single();
    if (!prev) throw new Error("Note not found.");
    const patchRow = {
      ...(s(input.title) ? { title: s(input.title)! } : {}),
      ...(input.body !== undefined ? { body_md: s(input.body) } : {}),
    };
    const { error } = await supabase.from("notes").update(patchRow).eq("id", noteId);
    if (error) throw new Error(error.message);
    return {
      summary: `Note updated: ${s(input.title) ?? prev.title}.`,
      undo: { note_id: noteId, prev },
    };
  },

  async delete_note(supabase, _userId, input) {
    const noteId = s(input.note_id);
    if (!noteId) throw new Error("note_id is required.");
    const { data: row } = await supabase
      .from("notes")
      .select("*")
      .eq("id", noteId)
      .single();
    if (!row) throw new Error("Note not found.");
    const { error } = await supabase.from("notes").delete().eq("id", noteId);
    if (error) throw new Error(error.message);
    return { summary: `Note deleted: ${row.title}.`, undo: { row } };
  },

  async update_person(supabase, _userId, input) {
    const personId = s(input.person_id);
    if (!personId) throw new Error("person_id is required.");
    const { data: prev } = await supabase
      .from("people")
      .select("name, org, role, emails, phones, context_md, unverified")
      .eq("id", personId)
      .single();
    if (!prev) throw new Error("Person not found.");
    const email = s(input.email);
    const phone = s(input.phone);
    const { error } = await supabase
      .from("people")
      .update({
        ...(s(input.name) ? { name: s(input.name)! } : {}),
        ...(input.org !== undefined ? { org: s(input.org) } : {}),
        ...(input.role !== undefined ? { role: s(input.role) } : {}),
        ...(email ? { emails: [email.toLowerCase()] } : {}),
        ...(phone ? { phones: [phone] } : {}),
        ...(input.context !== undefined ? { context_md: s(input.context) } : {}),
        // Only Tapas's own confirmation clears the flag; a model asserting it
        // still shows up in the audit trail with this action.
        ...(input.verified === true ? { unverified: false } : {}),
        ...(input.verified === false ? { unverified: true } : {}),
      })
      .eq("id", personId);
    if (error) throw new Error(error.message);
    return {
      summary: `Person updated: ${s(input.name) ?? prev.name}.`,
      undo: { person_id: personId, prev },
    };
  },

  async delete_person(supabase, _userId, input) {
    const personId = s(input.person_id);
    if (!personId) throw new Error("person_id is required.");
    const { data: row } = await supabase
      .from("people")
      .select("*")
      .eq("id", personId)
      .single();
    if (!row) throw new Error("Person not found.");
    const { error } = await supabase.from("people").delete().eq("id", personId);
    if (error) throw new Error(error.message);
    return { summary: `Person deleted: ${row.name}.`, undo: { row } };
  },

  async update_obligation(supabase, userId, input) {
    const obligationId = s(input.obligation_id);
    if (!obligationId) throw new Error("obligation_id is required.");
    const { data: prev } = await supabase
      .from("recurring_obligations")
      .select("name, amount, due_day, due_month, autopay, active")
      .eq("id", obligationId)
      .single();
    if (!prev) throw new Error("Obligation not found.");
    const { error } = await supabase
      .from("recurring_obligations")
      .update({
        ...(s(input.name) ? { name: s(input.name)! } : {}),
        ...(typeof input.amount === "number"
          ? { amount: input.amount, variable_amount: false }
          : {}),
        ...(Number.isInteger(input.due_day) ? { due_day: input.due_day as number } : {}),
        ...(Number.isInteger(input.due_month)
          ? { due_month: input.due_month as number }
          : {}),
        ...(typeof input.autopay === "boolean" ? { autopay: input.autopay } : {}),
        ...(typeof input.active === "boolean" ? { active: input.active } : {}),
      })
      .eq("id", obligationId);
    if (error) throw new Error(error.message);
    // The reminder follows the obligation: retiring one removes its event.
    await syncObligationReminder(userId, obligationId);
    return {
      summary: `Obligation updated: ${s(input.name) ?? prev.name}.`,
      undo: { obligation_id: obligationId, prev },
    };
  },

  async delete_obligation(supabase, userId, input) {
    const obligationId = s(input.obligation_id);
    if (!obligationId) throw new Error("obligation_id is required.");
    const { data: row } = await supabase
      .from("recurring_obligations")
      .select("*")
      .eq("id", obligationId)
      .single();
    if (!row) throw new Error("Obligation not found.");
    await removeObligationReminder(userId, obligationId);
    const { error } = await supabase
      .from("recurring_obligations")
      .delete()
      .eq("id", obligationId);
    if (error) throw new Error(error.message);
    return { summary: `Obligation deleted: ${row.name}.`, undo: { row } };
  },

  async add_finance_item(supabase, userId, input) {
    const name = s(input.name);
    const kind = s(input.kind);
    if (!name || !kind) throw new Error("A kind and name are required.");
    const keyDate = s(input.key_date);
    const { data, error } = await supabase
      .from("finance_items")
      .insert({
        user_id: userId,
        kind: kind as Database["public"]["Enums"]["finance_item_kind"],
        name,
        institution: s(input.institution),
        value: typeof input.value === "number" ? input.value : null,
        key_date: keyDate,
        key_date_type: s(input.key_date_type) as
          | Database["public"]["Enums"]["finance_key_date_type"]
          | null,
        notes: s(input.notes),
      })
      .select("id")
      .single();
    if (error || !data) throw new Error(error?.message ?? "Could not save it.");
    // A maturity writes the calendar reminder, a review date writes none.
    // The assistant path goes through the same writer his own form uses.
    await syncFinanceReminder(userId, data.id);
    return { summary: `Holding recorded: ${name}.`, undo: { finance_item_id: data.id } };
  },

  async update_finance_item(supabase, userId, input) {
    const itemId = s(input.finance_item_id);
    if (!itemId) throw new Error("finance_item_id is required.");
    const { data: prev } = await supabase
      .from("finance_items")
      .select("name, institution, value, key_date, key_date_type, notes")
      .eq("id", itemId)
      .single();
    if (!prev) throw new Error("Holding not found.");
    // The wire is not trusted: an unknown key-date type is refused rather
    // than written, since it decides whether this interrupts him.
    const keyDateType = s(input.key_date_type);
    if (keyDateType && !isFinanceKeyDateType(keyDateType)) {
      throw new Error("key_date_type must be 'maturity' or 'review'.");
    }
    const { error } = await supabase
      .from("finance_items")
      .update({
        ...(s(input.name) ? { name: s(input.name)! } : {}),
        ...(input.institution !== undefined ? { institution: s(input.institution) } : {}),
        ...(typeof input.value === "number" ? { value: input.value } : {}),
        ...(s(input.key_date) ? { key_date: s(input.key_date) } : {}),
        ...(keyDateType
          ? {
              key_date_type:
                keyDateType as Database["public"]["Enums"]["finance_key_date_type"],
            }
          : {}),
        ...(input.notes !== undefined ? { notes: s(input.notes) } : {}),
      })
      .eq("id", itemId);
    if (error) throw new Error(error.message);
    // Turning a maturity into a review date removes the event it had, by the
    // same path that wrote it, so no orphan is left on the calendar.
    await syncFinanceReminder(userId, itemId);
    return {
      summary: `Holding updated: ${s(input.name) ?? prev.name}.`,
      undo: { finance_item_id: itemId, prev },
    };
  },

  async delete_finance_item(supabase, userId, input) {
    const itemId = s(input.finance_item_id);
    if (!itemId) throw new Error("finance_item_id is required.");
    const { data: row } = await supabase
      .from("finance_items")
      .select("*")
      .eq("id", itemId)
      .single();
    if (!row) throw new Error("Holding not found.");
    await removeFinanceReminder(userId, itemId);
    const { error } = await supabase.from("finance_items").delete().eq("id", itemId);
    if (error) throw new Error(error.message);
    return { summary: `Holding deleted: ${row.name}.`, undo: { row } };
  },

  async update_event_solo(supabase, userId, input) {
    // Same attendee rule as creation: this path can never carry invitees.
    assertNoAttendees(input);
    const eventId = s(input.event_id);
    if (!eventId) throw new Error("event_id is required.");
    const { data: ev } = await supabase
      .from("events")
      .select("id, title, description, location, start_ts, end_ts, all_day, source")
      .eq("id", eventId)
      .single();
    if (!ev) throw new Error("Event not found.");
    if (ev.source !== "app") {
      throw new Error(
        "That event came from a synced calendar, so the app will not edit it."
      );
    }
    const date = s(input.date);
    const start = s(input.start_time);
    const end = s(input.end_time);
    const baseCivil = date ? civil(date) : istCivilOf(ev.start_ts);
    const allDay = start ? false : date ? !!ev.all_day : !!ev.all_day;
    const startIso = start
      ? istInstant(baseCivil, hm(start).h, hm(start).m).toISOString()
      : date
        ? istInstant(baseCivil, istHourOf(ev.start_ts), istMinuteOf(ev.start_ts)).toISOString()
        : ev.start_ts;
    const endIso = end
      ? istInstant(baseCivil, hm(end).h, hm(end).m).toISOString()
      : (ev.end_ts ?? undefined);
    const r = await updateEvent(
      userId,
      eventId,
      {
        title: s(input.title) ?? ev.title,
        description: (s(input.description) ?? ev.description) ?? undefined,
        location: (s(input.location) ?? ev.location) ?? undefined,
        startIso,
        endIso,
        allDay,
      },
      false
    );
    return {
      summary: `Event updated: ${s(input.title) ?? ev.title}.`,
      undo: { event_update: { id: r.id, prev: ev } },
    };
  },

  async delete_event(supabase, userId, input) {
    const eventId = s(input.event_id);
    if (!eventId) throw new Error("event_id is required.");
    const { data: ev } = await supabase
      .from("events")
      .select("title, source")
      .eq("id", eventId)
      .single();
    if (!ev) throw new Error("Event not found.");
    // deleteAppEvent refuses anything not created by the app; checking here
    // too means the model gets a readable reason instead of a raw throw.
    if (ev.source !== "app") {
      throw new Error(
        "That event came from a synced calendar. Only events the app created can be deleted."
      );
    }
    await deleteAppEvent(userId, eventId);
    return { summary: `Event deleted: ${ev.title}.`, undo: null };
  },

  async scan_mail(_supabase, _userId, _input, owner) {
    const { runMailScan } = await import("@/lib/assistant/scan");
    const summary = await runMailScan(owner);
    return {
      summary:
        `Mail scan: ${summary.scanned} emails read, ${summary.created} task` +
        `${summary.created === 1 ? "" : "s"} proposed.` +
        (summary.notes.length ? ` ${summary.notes.join(" ")}` : ""),
      undo: null,
    };
  },

  async undo_action(_supabase, _userId, input, owner) {
    const actionId = s(input.action_id);
    if (!actionId) throw new Error("action_id is required.");
    const r = await undoExecutedAction(actionId, owner);
    if (!r.ok) throw new Error(r.message ?? "That action could not be undone.");
    return { summary: "The earlier action was undone.", undo: null };
  },

  async reject_queued_action(_supabase, _userId, input, owner) {
    const actionId = s(input.action_id);
    if (!actionId) throw new Error("action_id is required.");
    const r = await rejectProposedAction(actionId, owner);
    if (!r.ok) throw new Error(r.message ?? "That action could not be rejected.");
    return { summary: "The queued action was discarded; it can never be sent.", undo: null };
  },

  // --- travel desk ---------------------------------------------------------
  // Trips, their legs and their expenses are Tapas's own records, so they sit
  // in the autonomous bucket and every one of them is undoable. There is no
  // bill tool: M6d removed it. Nothing here writes a bills row, computes an
  // invoice number or posts a claim to anybody; the app only holds the month
  // and hands it over.

  async create_trip(supabase, userId, input) {
    const title = s(input.title);
    const purpose = s(input.purpose);
    if (!title || !purpose) throw new Error("A purpose and title are required.");
    const workStreamId = await resolveWorkStream(supabase, s(input.work_stream));
    const r = await createTrip(supabase, userId, {
      purpose: purpose as Database["public"]["Enums"]["trip_purpose"],
      title,
      work_stream_id: workStreamId,
      start_date: s(input.start_date),
      end_date: s(input.end_date),
      cities: Array.isArray(input.cities)
        ? (input.cities as unknown[]).filter((c): c is string => typeof c === "string")
        : [],
      bills_to:
        (s(input.bills_to) as Database["public"]["Enums"]["trip_bills_to"] | null) ??
        undefined,
      notes: s(input.notes),
      session_label: s(input.session_label),
      session_date: s(input.session_date),
      hotel_arrangement: hotelArrangement(input.hotel_arrangement),
      // Same seeding path as the add-trip drawer: one implementation, so the
      // steps and their dates cannot differ between the app and a connector.
      with_checklist: input.with_checklist === true,
    });
    if (!r.ok) throw new Error(r.message);
    return {
      summary: `Trip created: ${title}.${r.note ? ` ${r.note}` : ""}`,
      undo: { trip_id: r.id, checklist_task_ids: r.checklistTaskIds ?? [] },
    };
  },

  async update_trip(supabase, userId, input) {
    const tripId = s(input.trip_id);
    if (!tripId) throw new Error("trip_id is required.");
    const { data: prev } = await supabase
      .from("trips")
      .select("title, status, start_date, end_date, bills_to, notes, hotel_arrangement, session_label, session_date")
      .eq("id", tripId)
      .single();
    if (!prev) throw new Error("Trip not found.");
    const r = await updateTrip(supabase, userId, tripId, {
      ...(s(input.title) ? { title: s(input.title)! } : {}),
      ...(s(input.status)
        ? { status: s(input.status) as Database["public"]["Enums"]["trip_status"] }
        : {}),
      ...(s(input.start_date) ? { start_date: s(input.start_date) } : {}),
      ...(s(input.end_date) ? { end_date: s(input.end_date) } : {}),
      ...(s(input.session_label) ? { session_label: s(input.session_label) } : {}),
      ...(s(input.session_date) ? { session_date: s(input.session_date) } : {}),
      ...(s(input.bills_to)
        ? {
            bills_to: s(
              input.bills_to
            ) as Database["public"]["Enums"]["trip_bills_to"],
          }
        : {}),
      ...(input.notes !== undefined ? { notes: s(input.notes) } : {}),
      ...(s(input.hotel_arrangement)
        ? { hotel_arrangement: hotelArrangement(input.hotel_arrangement) }
        : {}),
    });
    if (!r.ok) throw new Error(r.message);
    return {
      summary: `Trip updated: ${s(input.title) ?? prev.title}.`,
      undo: { trip_id: tripId, prev },
    };
  },

  async log_trip_leg(supabase, userId, input) {
    const tripId = s(input.trip_id);
    const date = s(input.date);
    if (!tripId || !date) throw new Error("trip_id and date are required.");
    const mode = s(input.mode) as TransportMode | null;
    const leg: TripLeg = {
      from: s(input.from_city) ?? "",
      to: s(input.to_city) ?? "",
      date,
      mode: mode && TRANSPORT_MODES.includes(mode) ? mode : "other",
      cost: typeof input.cost === "number" ? input.cost : null,
    };
    const r = await addTripLeg(supabase, userId, tripId, leg);
    if (!r.ok) throw new Error(r.message);
    return {
      summary: `Leg logged: ${leg.from} to ${leg.to} on ${formatDateIST(
        `${date}T00:00:00+05:30`
      )}.`,
      undo: { trip_id: tripId, previous_legs: r.previous },
    };
  },

  async add_trip_expense(supabase, userId, input) {
    const tripId = s(input.trip_id);
    const category = s(input.category);
    const date = s(input.date);
    if (!tripId || !category || !date) {
      throw new Error("trip_id, category and date are required.");
    }
    if (typeof input.amount !== "number") throw new Error("An amount is required.");
    const r = await addTripExpense(supabase, userId, {
      trip_id: tripId,
      category: category as Database["public"]["Enums"]["trip_expense_category"],
      amount: input.amount,
      date,
      billable: input.billable === true,
      // Reference string only. There is no upload path anywhere in this app.
      receipt_ref: s(input.receipt_ref),
    });
    if (!r.ok) throw new Error(r.message);
    return {
      summary: `Expense recorded: ${category} ${input.amount} on ${formatDateIST(
        `${date}T00:00:00+05:30`
      )}${input.billable === true ? ", billable" : ""}.`,
      undo: { expense_id: r.id },
    };
  },

  async add_event_solo(supabase, userId, input) {
    // Structural gates for attack A3: the schema has no attendees field,
    // smuggled attendee keys are refused here, and confirmed=false below
    // means prepareEventWrite would throw on any attendee that slipped
    // through anyway. Writes go only to the account's write-back calendar.
    assertNoAttendees(input);
    const slot = s(input.account);
    const title = s(input.title);
    const date = s(input.date);
    if (!slot || !title || !date) throw new Error("Account, title and date are required.");
    const account = await resolveAccount(supabase, slot);
    const c = civil(date);
    const start = s(input.start_time);
    const end = s(input.end_time);
    const allDay = !start;
    const startIso = allDay
      ? istInstant(c, 0, 0).toISOString()
      : istInstant(c, hm(start).h, hm(start).m).toISOString();
    const endIso = !allDay && end
      ? istInstant(c, hm(end).h, hm(end).m).toISOString()
      : undefined;
    const r = await createEvent(
      userId,
      account.id,
      {
        title,
        description: s(input.description) ?? undefined,
        location: s(input.location) ?? undefined,
        startIso,
        endIso,
        allDay,
      },
      false // never confirmed: any attendee-bearing payload throws
    );
    return {
      summary: `Event added to the ${slot} calendar: ${title} on ${formatDateIST(startIso)}.`,
      undo: { event_id: r.id },
      accountId: account.id,
    };
  },
};

// ---------------------------------------------------------------------------
// Approval lifecycle (owner-session server actions call these)
// ---------------------------------------------------------------------------
export async function approveAndExecute(
  actionId: string,
  actor?: Actor
): Promise<{
  ok: boolean;
  message?: string;
}> {
  const owner = await ownerClient(actor);
  const { supabase, userId } = owner;
  const { data: action } = await supabase
    .from("assistant_actions")
    .select("id, kind, status, payload")
    .eq("id", actionId)
    .single();
  if (!action) return { ok: false, message: "Action not found." };
  if (action.status !== "proposed") {
    return { ok: false, message: `This action is already ${action.status}.` };
  }
  // A B10 downgrade sits in the same queue but is not an approval request: its
  // target did not resolve, so approving would change nothing and would strand
  // the row in 'approved' with no executor willing to run it. Refused before
  // the status flip, so only Reject can move it.
  if (!SEND_CLASS.has(action.kind)) {
    return {
      ok: false,
      message:
        "This is here because the assistant could not find what it was pointed at, " +
        "not for approval. Approving it would change nothing. Dismiss it, and ask " +
        "again naming something that exists.",
    };
  }
  // Approval binds the exact payload: the hash recorded here is what the
  // executor verifies. CAS on status=proposed so a double tap approves once.
  const { data: approved } = await supabase
    .from("assistant_actions")
    .update({
      status: "approved",
      approved_at: new Date().toISOString(),
      payload_hash: hashPayload(action.payload),
    })
    .eq("id", actionId)
    .eq("status", "proposed")
    .select("id");
  if (!approved?.length) return { ok: false, message: "The action changed state." };
  await audit(
    supabase,
    userId,
    "approve",
    actionId,
    { kind: action.kind },
    prov(owner, "owner_approval", action.kind, actionId, hashPayload(action.payload))
  );
  return executeApprovedAction(actionId, owner);
}

export async function executeApprovedAction(
  actionId: string,
  actor?: Actor
): Promise<{
  ok: boolean;
  message?: string;
}> {
  const owner = await ownerClient(actor);
  const { supabase, userId } = owner;
  // Captured as the gate loads the row, so the audit rows below can name the
  // kind and the hash that was verified without a second read.
  let kind = "unknown";
  let verifiedHash: string | null = null;
  return runApprovedExecution({
    loadAction: async () => {
      const { data } = await supabase
        .from("assistant_actions")
        .select("id, kind, status, payload, payload_hash")
        .eq("id", actionId)
        .single();
      if (data) {
        kind = data.kind;
        verifiedHash = data.payload_hash;
      }
      return data ?? null;
    },
    claimExecution: async () => {
      const { data, error } = await supabase
        .from("assistant_actions")
        .update({ executed_at: new Date().toISOString() })
        .eq("id", actionId)
        .eq("status", "approved")
        .is("executed_at", null)
        .select("id");
      if (error) throw new Error(error.message);
      return (data?.length ?? 0) > 0;
    },
    perform: (kind, payload) =>
      performSendClass(owner, kind, payload as Record<string, unknown>),
    markExecuted: async (result) => {
      await supabase
        .from("assistant_actions")
        .update({ status: "executed", result: result as Json })
        .eq("id", actionId);
    },
    markFailed: async (message) => {
      await supabase
        .from("assistant_actions")
        .update({ status: "failed", error: message })
        .eq("id", actionId);
    },
    audit: (action, meta) =>
      audit(
        supabase,
        userId,
        action,
        actionId,
        meta,
        prov(owner, "owner_approval", kind, actionId, verifiedHash)
      ),
  });
}

// The ONLY function in the codebase that sends mail or writes an
// attendee-bearing event, reachable solely through runApprovedExecution.
async function performSendClass(
  actor: Actor,
  kind: string,
  payload: Record<string, unknown>
): Promise<unknown> {
  const { userId } = actor;
  const accountId = s(payload.account_id);
  if (!accountId) throw new Error("The action has no account bound to it.");

  if (kind === "send_email") {
    return sendEmail(actor, accountId, payload);
  }
  if (kind === "propose_event_with_invites") {
    const c = civil(s(payload.date) ?? "");
    const start = s(payload.start_time);
    const end = s(payload.end_time);
    const attendees = (payload.attendees as { email: string; name?: string }[]) ?? [];
    const r = await createEvent(
      userId,
      accountId,
      {
        title: s(payload.title) ?? "",
        description: s(payload.description) ?? undefined,
        location: s(payload.location) ?? undefined,
        startIso: start
          ? istInstant(c, hm(start).h, hm(start).m).toISOString()
          : istInstant(c, 0, 0).toISOString(),
        endIso: end ? istInstant(c, hm(end).h, hm(end).m).toISOString() : undefined,
        allDay: !start,
        attendees,
      },
      true // approved through the queue; this is the confirmation
    );
    return { event_id: r.id, ext_event_id: r.extEventId };
  }
  throw new Error(`Unknown send-class kind: ${kind}`);
}

async function sendEmail(
  actor: Actor,
  accountId: string,
  payload: Record<string, unknown>
): Promise<unknown> {
  const { supabase } = actor;
  const { data: account } = await supabase
    .from("accounts")
    .select("id, email, provider, slot")
    .eq("id", accountId)
    .single();
  if (!account) throw new Error("Account not found.");
  const to = (payload.to as string[]) ?? [];
  const cc = (payload.cc as string[]) ?? [];
  const subject = s(payload.subject) ?? "";
  const body = typeof payload.body === "string" ? payload.body : "";
  if (!to.length) throw new Error("No recipients.");

  if (account.provider === "google") {
    const mime = [
      `From: ${account.email}`,
      `To: ${to.join(", ")}`,
      ...(cc.length ? [`Cc: ${cc.join(", ")}`] : []),
      `Subject: ${subject}`,
      "MIME-Version: 1.0",
      'Content-Type: text/plain; charset="UTF-8"',
      "",
      body,
    ].join("\r\n");
    const res = await withResourceAuth(accountId, (token) =>
      fetch("https://gmail.googleapis.com/gmail/v1/users/me/messages/send", {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ raw: Buffer.from(mime, "utf8").toString("base64url") }),
      })
    );
    if (!res.ok) throw new Error(`Gmail send failed (${res.status}).`);
    const j = (await res.json()) as { id?: string };
    return { provider_message_id: j.id ?? null };
  }

  // Microsoft Graph
  const res = await withResourceAuth(accountId, (token) =>
    fetch("https://graph.microsoft.com/v1.0/me/sendMail", {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        message: {
          subject,
          body: { contentType: "Text", content: body },
          toRecipients: to.map((a) => ({ emailAddress: { address: a } })),
          ccRecipients: cc.map((a) => ({ emailAddress: { address: a } })),
        },
        saveToSentItems: true,
      }),
    })
  );
  if (!res.ok && res.status !== 202) throw new Error(`Graph send failed (${res.status}).`);
  return { provider_message_id: null };
}

// ---------------------------------------------------------------------------
// Reject and undo
// ---------------------------------------------------------------------------
export async function rejectProposedAction(
  actionId: string,
  actor?: Actor
): Promise<{
  ok: boolean;
  message?: string;
}> {
  const owner = await ownerClient(actor);
  const { supabase, userId } = owner;
  const { data } = await supabase
    .from("assistant_actions")
    .update({ status: "rejected", rejected_at: new Date().toISOString() })
    .eq("id", actionId)
    .eq("status", "proposed")
    .select("id, kind");
  if (!data?.length) return { ok: false, message: "Only proposed actions can be rejected." };
  await audit(
    supabase,
    userId,
    "reject",
    actionId,
    { kind: data[0].kind },
    // Discarding a draft is one of the reversible acts the assistant may do
    // alone, and it is the same act when Tapas taps Reject himself; the
    // actor_origin on the row is what tells the two apart.
    prov(owner, "autonomous_bucket", "reject_queued_action", actionId)
  );
  return { ok: true };
}

// Kinds with a reversible inverse. Send-class actions are deliberately absent:
// a sent mail cannot be unsent.
const UNDOABLE = new Set([
  "delete_task",
  "delete_note",
  "delete_person",
  "delete_obligation",
  "delete_finance_item",
  "create_task",
  "update_task",
  "set_reminder",
  "add_note",
  "update_note",
  "add_person",
  "update_person",
  "add_obligation",
  "update_obligation",
  "add_project",
  "add_finance_item",
  "update_finance_item",
  "add_event_solo",
  "create_trip",
  "update_trip",
  "log_trip_leg",
  "add_trip_expense",
]);

export async function undoExecutedAction(
  actionId: string,
  actor?: Actor
): Promise<{
  ok: boolean;
  message?: string;
}> {
  const owner = await ownerClient(actor);
  const { supabase, userId } = owner;
  const { data: action } = await supabase
    .from("assistant_actions")
    .select("id, kind, status, result")
    .eq("id", actionId)
    .single();
  if (!action) return { ok: false, message: "Action not found." };
  if (action.status !== "executed") {
    return { ok: false, message: `Only executed actions can be undone (this one is ${action.status}).` };
  }
  if (!UNDOABLE.has(action.kind)) {
    return { ok: false, message: `${action.kind} cannot be undone.` };
  }
  const undo = ((action.result as Record<string, unknown> | null)?.undo ?? null) as
    | Record<string, unknown>
    | null;
  if (!undo) return { ok: false, message: "No undo information was recorded." };

  // Claim the row first (executed -> undone via the trigger whitelist), so a
  // double tap performs the inverse exactly once.
  const { data: claimed } = await supabase
    .from("assistant_actions")
    .update({ status: "undone", undone_at: new Date().toISOString() })
    .eq("id", actionId)
    .eq("status", "executed")
    .select("id");
  if (!claimed?.length) return { ok: false, message: "The action changed state." };

  try {
    await performUndo(supabase, userId, action.kind, undo);
    await audit(
      supabase,
      userId,
      "undo",
      actionId,
      { kind: action.kind },
      prov(owner, "autonomous_bucket", "undo_action", actionId)
    );
    return { ok: true };
  } catch (e) {
    const message = e instanceof Error ? e.message : "Undo failed.";
    await audit(
      supabase,
      userId,
      "undo_failed",
      actionId,
      { reason: message },
      prov(owner, "autonomous_bucket", "undo_action", actionId)
    );
    return { ok: false, message };
  }
}

async function performUndo(
  supabase: Db,
  userId: string,
  kind: string,
  undo: Record<string, unknown>
): Promise<void> {
  switch (kind) {
    case "create_task": {
      const r = await deleteTask(supabase, userId, String(undo.task_id));
      if (!r.ok) throw new Error(r.message ?? "Could not delete the task.");
      return;
    }
    case "update_task":
    case "set_reminder": {
      const prev = (undo.prev ?? {}) as Record<string, unknown>;
      // "undo" puts the snapshot back exactly as it was, priority provenance
      // included, and is still refused if he has rated the task by hand since.
      const r = await updateTask(supabase, userId, String(undo.task_id), {
        title: prev.title as string | undefined,
        notes: (prev.notes as string | null | undefined) ?? null,
        status: prev.status as TaskInput["status"],
        priority: prev.priority as TaskInput["priority"],
        priority_source: prev.priority_source as TaskInput["priority_source"],
        priority_reason: (prev.priority_reason as string | null | undefined) ?? null,
        due_ts: (prev.due_ts as string | null | undefined) ?? null,
        remind_offsets: prev.remind_offsets as number[] | undefined,
        reminder_mode: isReminderMode(prev.reminder_mode)
          ? prev.reminder_mode
          : undefined,
        trip_id: (prev.trip_id as string | null | undefined) ?? null,
      }, "undo");
      if (!r.ok) throw new Error(r.message);
      return;
    }
    case "add_note": {
      await supabase.from("notes").delete().eq("id", String(undo.note_id));
      return;
    }
    case "update_note": {
      const prev = (undo.prev ?? {}) as Record<string, unknown>;
      await supabase
        .from("notes")
        .update({ title: prev.title as string, body_md: prev.body_md as string | null })
        .eq("id", String(undo.note_id));
      return;
    }
    case "update_person": {
      const prev = (undo.prev ?? {}) as Record<string, unknown>;
      await supabase
        .from("people")
        .update({
          name: prev.name as string,
          org: prev.org as string | null,
          role: prev.role as string | null,
          emails: prev.emails as string[],
          phones: prev.phones as string[],
          context_md: prev.context_md as string | null,
          unverified: prev.unverified as boolean,
        })
        .eq("id", String(undo.person_id));
      return;
    }
    case "update_obligation": {
      const prev = (undo.prev ?? {}) as Record<string, unknown>;
      await supabase
        .from("recurring_obligations")
        .update({
          name: prev.name as string,
          amount: prev.amount as number | null,
          due_day: prev.due_day as number | null,
          due_month: prev.due_month as number | null,
          autopay: prev.autopay as boolean,
          active: prev.active as boolean,
        })
        .eq("id", String(undo.obligation_id));
      await syncObligationReminder(userId, String(undo.obligation_id));
      return;
    }
    // Restoring a deleted row: the whole record was kept, original id and
    // all, so undo is a genuine reversal rather than a fresh copy.
    case "delete_task": {
      const row = undo.row as Record<string, unknown>;
      const { error } = await supabase.from("tasks").insert(row as never);
      if (error) throw new Error(`Could not restore the task: ${error.message}`);
      if (row.due_ts) await syncTaskReminder(userId, String(row.id));
      return;
    }
    case "delete_note": {
      const { error } = await supabase.from("notes").insert(undo.row as never);
      if (error) throw new Error(`Could not restore the note: ${error.message}`);
      return;
    }
    case "delete_person": {
      const { error } = await supabase.from("people").insert(undo.row as never);
      if (error) throw new Error(`Could not restore the person: ${error.message}`);
      return;
    }
    case "delete_obligation": {
      const row = undo.row as Record<string, unknown>;
      const { error } = await supabase
        .from("recurring_obligations")
        .insert(row as never);
      if (error) throw new Error(`Could not restore the obligation: ${error.message}`);
      await syncObligationReminder(userId, String(row.id));
      return;
    }
    case "delete_finance_item": {
      const row = undo.row as Record<string, unknown>;
      const { error } = await supabase.from("finance_items").insert(row as never);
      if (error) throw new Error(`Could not restore the holding: ${error.message}`);
      // Restoring the row restores its reminder too, the same way a restored
      // obligation gets its own back.
      await syncFinanceReminder(userId, String(row.id));
      return;
    }
    case "add_project": {
      await supabase.from("projects").delete().eq("id", String(undo.project_id));
      return;
    }
    case "add_finance_item": {
      await removeFinanceReminder(userId, String(undo.finance_item_id));
      await supabase
        .from("finance_items")
        .delete()
        .eq("id", String(undo.finance_item_id));
      return;
    }
    case "update_finance_item": {
      const prev = (undo.prev ?? {}) as Record<string, unknown>;
      const itemId = String(undo.finance_item_id);
      await supabase
        .from("finance_items")
        .update({
          name: prev.name as string,
          institution: (prev.institution ?? null) as string | null,
          value: prev.value as number | null,
          key_date: prev.key_date as string | null,
          key_date_type: (prev.key_date_type ??
            null) as Database["public"]["Enums"]["finance_key_date_type"] | null,
          notes: prev.notes as string | null,
        })
        .eq("id", itemId);
      // The reminder follows the restored row, so undoing a maturity that was
      // turned into a review date puts the calendar entry back.
      await syncFinanceReminder(userId, itemId);
      return;
    }
    case "add_person": {
      await supabase.from("people").delete().eq("id", String(undo.person_id));
      return;
    }
    case "add_obligation": {
      // ponytail: direct delete; the obligation was just created by the
      // assistant, so no reminder event exists yet for it in practice.
      await supabase
        .from("recurring_obligations")
        .delete()
        .eq("id", String(undo.obligation_id));
      return;
    }
    case "add_event_solo": {
      await deleteAppEvent(userId, String(undo.event_id));
      return;
    }
    case "create_trip": {
      // The seeded checklist goes with it. The FK is set null so a real trip
      // deletion leaves the steps behind as ordinary tasks, which is right,
      // but undoing the creation must leave no trace at all.
      const seeded = Array.isArray(undo.checklist_task_ids)
        ? (undo.checklist_task_ids as unknown[]).filter(
            (v): v is string => typeof v === "string"
          )
        : [];
      for (const taskId of seeded) await deleteTask(supabase, userId, taskId);
      const r = await deleteTrip(supabase, userId, String(undo.trip_id));
      if (!r.ok) throw new Error(r.message ?? "Could not delete the trip.");
      return;
    }
    case "update_trip": {
      const prev = (undo.prev ?? {}) as Record<string, unknown>;
      const r = await updateTrip(supabase, userId, String(undo.trip_id), {
        title: prev.title as string,
        status: prev.status as Database["public"]["Enums"]["trip_status"],
        start_date: (prev.start_date as string | null) ?? null,
        end_date: (prev.end_date as string | null) ?? null,
        bills_to: prev.bills_to as Database["public"]["Enums"]["trip_bills_to"],
        notes: (prev.notes as string | null) ?? null,
      });
      if (!r.ok) throw new Error(r.message);
      return;
    }
    case "log_trip_leg": {
      // The whole leg array before the append goes back, so the undo is exact
      // even if two legs share a date.
      const r = await updateTrip(supabase, userId, String(undo.trip_id), {
        legs: (undo.previous_legs ?? []) as TripLeg[],
      });
      if (!r.ok) throw new Error(r.message);
      return;
    }
    case "add_trip_expense": {
      const r = await deleteTripExpense(supabase, userId, String(undo.expense_id));
      if (!r.ok) throw new Error(r.message ?? "Could not delete the expense.");
      return;
    }
    default:
      throw new Error(`${kind} cannot be undone.`);
  }
}
