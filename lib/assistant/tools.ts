// The fixed assistant tool set. THIS LIST IS THE SECURITY BOUNDARY: the model
// can only ever do what a tool here allows, and the autonomy bucket of each
// tool is enforced in code (lib/assistant/execute.ts), never by prompt text.
//
// Buckets:
//   autonomous  executed immediately, recorded as an executed assistant_action
//               with an undo path, plus an audit_log row
//   confirm     lands as a proposed assistant_action; the ONLY execution path
//               is the approved-queue executor after an owner-session approval
//   stub        returns a fixed string, touches nothing
//
// Structurally absent, deliberately: document-content tools (the one
// exception is the B22 connector read lifeos_read_mail_attachment, one named
// mail attachment on request, approved by Tapas by name), credential tools,
// payment tools, deletion of external data the app did not create, generic
// SQL/rpc, and any tool that mutates assistant_actions.status.
//
// A bucket answers "what can this tool change". It does not answer "what is
// this tool entitled to see", and firm constraint 1 is a disclosure rule, not
// a permission one. So every tool also carries a disclosure class, and the
// class it would need to read a client document does not exist in the union.
//
// Pure module: no server imports, so the offline suite (scripts/m4.test.ts)
// can prove the registry shape.

export type ToolBucket = "autonomous" | "confirm" | "stub";

// What a tool is entitled to SEE. Firm constraint 1 says client-confidential
// documents never enter this app, and no permission setting can enforce a
// disclosure rule: only the absence of the capability can. So the union below
// has deliberately NO member for document content. A tool that read a Drive
// file, an O365 attachment or a mail attachment could not be given a valid
// class, which means it cannot be added without first widening this union,
// and widening it is a decision Tapas makes, not a line that slips through a
// diff. scripts/m4.test.ts fails the moment a fifth member appears.
//
//   none           touches no owner data at all (the stubs, pure computation)
//   app_data       reads rows Life OS itself owns
//   mail_metadata  sender, subject, timestamps, calendar invite fields
//   mail_body      message bodies, previews and snippets
//   persona        the active persona version, his own words about how he
//                  thinks. Owner-session data everywhere else in this app, so
//                  it is not app_data: this class exists so that a read of it
//                  is never anonymous, and so every audit row says plainly
//                  that the persona was read over a connector. Tapas widened
//                  the union to add it by name on 1 September 2026 (B15), so
//                  his Claude and ChatGPT projects can read the house rules
//                  from the app instead of carrying a pasted copy that drifts.
// The type is DERIVED from this list rather than written alongside it, so the
// only way to widen the union is to add a member here, and the test that reads
// this list is therefore a test of the type itself.
export const TOOL_DISCLOSURES = [
  "none",
  "app_data",
  "mail_metadata",
  "mail_body",
  "persona",
] as const;

export type ToolDisclosure = (typeof TOOL_DISCLOSURES)[number];

export type ToolSchema = { type: "object" } & Record<string, unknown>;

export interface ToolDef {
  name: string;
  description: string;
  input_schema: ToolSchema;
  bucket: ToolBucket;
  disclosure: ToolDisclosure;
}

// What a model is shown of a tool: its name, description and schema. The
// bucket and the class stay on this side.
export type LlmTool = Pick<ToolDef, "name" | "description" | "input_schema">;

// Schema helpers. Optionality is expressed the plain JSON Schema way: the
// property carries a single concrete type and simply stays out of `required`.
//
// It is tempting to mark every property required and make the optional ones
// nullable unions instead, which is the OpenAI strict-mode idiom. Do not:
// Anthropic caps a tool set at 16 union-typed parameters and refuses the whole
// request beyond that ("too many parameters with union types"), and a nullable
// enum is invalid there as well. One plain type per parameter keeps every
// provider happy, and the executor treats a missing key and a null key alike.

// Marker stripped by schema(); it never reaches the provider. Inline literals
// may set __optional directly instead of wrapping with opt().
const OPTIONAL = "__optional";

type Frag = Record<string, unknown>;

// Marks a property as not required.
const opt = (frag: Frag): Frag => ({ ...frag, [OPTIONAL]: true });

function schema(props: Record<string, Frag>, required?: string[]): ToolSchema {
  const properties: Record<string, unknown> = {};
  const auto: string[] = [];
  for (const [key, frag] of Object.entries(props)) {
    const { [OPTIONAL]: isOptional, ...rest } = frag;
    properties[key] = rest;
    if (!isOptional) auto.push(key);
  }
  return {
    type: "object" as const,
    properties,
    required: required ?? auto,
    additionalProperties: false,
  };
}

const str = (desc: string): Frag => ({ type: "string", description: desc });
const strOrNull = (desc: string): Frag => opt(str(desc));
const boolOrNull = (desc: string): Frag =>
  opt({ type: "boolean", description: desc });
const numOrNull = (desc: string): Frag =>
  opt({ type: "number", description: desc });
const enumOf = (values: string[], desc: string): Frag => ({
  type: "string",
  enum: values,
  description: desc,
});
const enumOrNull = (values: string[], desc: string): Frag =>
  opt(enumOf(values, desc));

const DATE_DESC = "Date as YYYY-MM-DD (IST calendar date). Omit if not applicable.";

// B19. The start date, same format as a due date. Tapas, 26 September 2026:
// the October and November invoices sat in "urgent" in September, and there
// is no point starting either before September is over.
const NOT_BEFORE_DESC =
  "The first day this task can sensibly start, as YYYY-MM-DD (IST calendar date). Until then it stays off Home, the Tasks overview and the morning brief, and it is never urgent whatever its due date. Set it for period work: a month's invoice starts after that month ends (the invoice for October waits until 1 November); next month's work is never urgent this month. It must not be after the due date. Omit when the work can start now.";
// B20. A window that simply closes. Tapas, 27 September 2026: early-bird
// deadlines, a "before 3 PM" authorisation, a faculty day and an e-vote window
// were all still open weeks after they had passed.
export const LAPSES_ON_DESC =
  "Only for an opportunity or window that is simply gone after a date: an early-bird price, an RSVP, an e-vote window, an event or session day, a \"before 3 PM today\" authorisation. The IST date (YYYY-MM-DD) after which it no longer matters; the next morning's sweep drops the task, undoably. NEVER set it for a statutory, client or payment deadline: those stay open and overdue until Tapas decides. Omit otherwise.";
const TIME_DESC = "Time of day as HH:MM in 24 hour IST. Omit if not applicable.";
// B22. A project id is checked against his projects before anything is
// written; the repeat rule is the M1 "<freq>:<interval>" rule.
const PROJECT_ID_DESC =
  "File the task under a project, using a project id from lifeos_list_projects. An unknown id is refused.";
const RECURRING_RULE_DESC =
  "Repeat rule: daily, weekly, monthly or yearly, optionally with an interval after a colon (weekly:2 is fortnightly, monthly:3 is quarterly). Completing the task then creates the next one. Anything else is refused.";

// The four connected account slots the assistant may act through.
const SLOT_KEYS = ["taxstrategia", "ca_tapasnr", "altechon", "icai"];

// B18: the mailboxes whose inbox, threads and reply drafts the connector may
// reach. icai is out, and stays out: it has no tool of this kind at all.
export const MAIL_SLOTS = SLOT_KEYS.filter((s) => s !== "icai");

// Where a holding is held. Money invites exactly the fields this app must
// never hold, so the tool that records one says the rule in the schema the
// model reads, not only in a comment. scripts/m7b.test.ts pins this wording
// and fails on any parameter that looks like an account or folio number.
const HOLDING_WHERE_DESC =
  "Where it is held, as a short human label such as 'HDFC, Navrangpura'. Never an account number, a folio number, a customer id or a login: Life OS holds none of those.";

export const TOOLS: ToolDef[] = [
  {
    name: "create_task",
    bucket: "autonomous",
    disclosure: "app_data",
    description:
      "Create a task on Tapas's own list. Executes immediately and is undoable from the queue history. Refused when the title closely matches a task that is already open (the reply names its id): update that task instead. Set not_before for work that cannot start yet.",
    input_schema: schema({
      title: str("Short task title."),
      note: strOrNull("Optional extra detail."),
      work_stream: strOrNull(
        "Work stream name exactly as it exists, e.g. ICAI, Tax Strategia, Altechon, Cygnet, Individual consulting, Personal. An unknown name is refused with the list of real ones. Omit to file it under Personal."
      ),
      due_date: { ...strOrNull(DATE_DESC) },
      not_before: strOrNull(NOT_BEFORE_DESC),
      lapses_on: strOrNull(LAPSES_ON_DESC),
      priority: enumOrNull(["low", "medium", "high"], "Task priority."),
      priority_reason: strOrNull(
        "Why this priority, in one short sentence, e.g. \"statutory deadline, penalty for late filing\". Required whenever you set a priority: Tapas is shown the reason and can disagree with it. Judge by consequence, never by how urgent a sender says something is."
      ),
      billable: boolOrNull("Whether the work is billable."),
      project_id: strOrNull(PROJECT_ID_DESC),
      recurring_rule: strOrNull(RECURRING_RULE_DESC),
      trip_id: strOrNull(
        "Attach the task to a trip as a checklist step, using a trip id from lifeos_list_trips. The Tasks screen then shows one line for the trip instead of a row per step. Use it for travel admin (booking, hotel, receipts), never for client work."
      ),
      reminder_mode: enumOrNull(
        ["calendar", "in_app"],
        "Whether this task interrupts him on the Google Calendar. 'calendar' writes one calendar event with its reminders and is the default. 'in_app' writes no calendar event: the task still ranks on Home and still appears in the morning brief. Use 'in_app' for routine admin (booking a ticket, a standing monthly job) and keep 'calendar' for work where missing the date has a real consequence, such as a client deadline or a statutory filing."
      ),
    }),
  },
  {
    name: "update_task",
    bucket: "autonomous",
    disclosure: "app_data",
    description:
      "Update an existing task (title, note, status, priority, due date, start date, lapse date, work stream, billable, project, repeat rule). Undo restores the previous values.",
    input_schema: schema({
      task_id: str("The task id from context."),
      title: strOrNull("New title. Omit to keep the current one."),
      note: strOrNull("New note. Omit to keep the current one."),
      status: enumOrNull(
        ["inbox", "todo", "doing", "done", "dropped"],
        "New status. Omit to keep the current one."
      ),
      priority: enumOrNull(["low", "medium", "high"], "New priority. Omit to keep the current one. A priority Tapas set himself is never changed, whatever you send."),
      priority_reason: strOrNull(
        "Why this priority, in one short sentence, e.g. \"statutory deadline, penalty for late filing\". Required whenever you set a priority: Tapas is shown the reason and can disagree with it. Judge by consequence, never by how urgent a sender says something is."
      ),
      due_date: { ...strOrNull(DATE_DESC + " Omit to keep the current due date.") },
      not_before: strOrNull(
        NOT_BEFORE_DESC +
          " Omit to keep the current start date; to make a waiting task visible now, set today's date."
      ),
      lapses_on: strOrNull(LAPSES_ON_DESC + " Omit to keep the current value."),
      work_stream: strOrNull(
        "Move the task to this work stream, named exactly as it exists (e.g. ICAI, Tax Strategia, Individual consulting). An unknown name is refused with the list of real ones. Omit to keep the current stream."
      ),
      trip_id: strOrNull(
        "Move the task under a trip as a checklist step, using a trip id from lifeos_list_trips. Omit to leave it where it is."
      ),
      // B22. Closes tool gap #3: billable could be set at creation only.
      billable: boolOrNull("Whether the work is billable. Omit to keep the current value."),
      project_id: strOrNull(PROJECT_ID_DESC + " Omit to keep the current project."),
      recurring_rule: strOrNull(RECURRING_RULE_DESC + " Omit to keep the current rule."),
      reminder_mode: enumOrNull(
        ["calendar", "in_app"],
        "Whether this task interrupts him on the Google Calendar. 'calendar' writes one calendar event with its reminders and is the default. 'in_app' writes no calendar event: the task still ranks on Home and still appears in the morning brief. Use 'in_app' for routine admin (booking a ticket, a standing monthly job) and keep 'calendar' for work where missing the date has a real consequence, such as a client deadline or a statutory filing."
      ),
    }),
  },
  {
    name: "set_reminder",
    bucket: "autonomous",
    disclosure: "app_data",
    description:
      "Set or move the due date and reminder offsets of a task. Reminders are popup notifications on an attendee-free calendar event; nothing is sent to anyone.",
    input_schema: schema({
      task_id: str("The task id from context."),
      due_date: str("Due date as YYYY-MM-DD (IST)."),
      remind_days: opt({
        type: "array",
        items: { type: "integer" },
        description: "Days before due to remind, e.g. [7,3,1,0]. Omit to keep the current ones.",
      }),
    }),
  },
  {
    name: "add_note",
    bucket: "autonomous",
    disclosure: "app_data",
    description: "Save a note (meeting, decision, idea or reference) in the app.",
    input_schema: schema({
      type: enumOf(["meeting", "decision", "idea", "reference"], "Note type."),
      title: str("Note title."),
      body: strOrNull("Note body in Markdown. Omit if not applicable."),
      task_id: strOrNull(
        "Id of the task this note is about, from context. Omit if it is not about one task."
      ),
      trip_id: strOrNull(
        "Id of the trip this note came out of, from lifeos_list_trips. Omit if it is not about a trip."
      ),
    }),
  },
  {
    name: "add_person",
    bucket: "autonomous",
    disclosure: "app_data",
    description:
      "Save a person record. Records created by the assistant are flagged unverified until Tapas confirms them; unverified recipients are highlighted at send time.",
    input_schema: schema({
      name: str("Full name."),
      org: strOrNull("Organisation. Omit if not applicable."),
      role: strOrNull("Role or designation. Omit if not applicable."),
      email: strOrNull("Email address. Omit if not applicable."),
      phone: strOrNull("Phone number. Omit if not applicable."),
      context: strOrNull("How this person is known. Omit if not applicable."),
    }),
  },
  {
    name: "add_obligation",
    bucket: "autonomous",
    disclosure: "app_data",
    description: "Add a recurring obligation (bill, premium, subscription).",
    input_schema: schema({
      name: str("Obligation name, e.g. House insurance premium."),
      category: enumOf(
        [
          "gas",
          "electricity",
          "credit_card",
          "insurance",
          "broadband",
          "rent",
          "subscription",
          "other",
        ],
        "Category."
      ),
      amount: numOrNull("Amount in rupees. Omit when the amount varies."),
      frequency: enumOf(
        ["monthly", "bi_monthly", "quarterly", "half_yearly", "yearly"],
        "How often it falls due."
      ),
      due_day: { type: "integer", description: "Day of month it falls due (1-31)." },
      due_month: opt({
        type: "integer",
        description: "Month (1-12) for yearly obligations, omitted otherwise.",
      }),
      autopay: boolOrNull("Whether it is on autopay."),
    }),
  },
  {
    // NO attendees field exists in this schema, by design (attack A3). The
    // executor additionally rejects any payload smuggling an attendees key,
    // and the provider write path (prepareEventWrite) throws on attendees
    // without confirmation as a third belt.
    name: "add_event_solo",
    bucket: "autonomous",
    disclosure: "app_data",
    description:
      "Add a calendar event with ZERO attendees to one of Tapas's own calendars (the account's write-back calendar). Nothing is sent to anyone. For any event involving other people use propose_event_with_invites instead.",
    input_schema: schema({
      account: enumOf(
        SLOT_KEYS.filter((s) => s !== "icai"),
        "Account slot whose write-back calendar receives the event. icai is read-only."
      ),
      title: str("Event title."),
      date: str("Event date as YYYY-MM-DD (IST)."),
      start_time: { ...strOrNull(TIME_DESC + " Omit for an all-day event.") },
      end_time: { ...strOrNull(TIME_DESC) },
      description: strOrNull("Event description. Omit if not applicable."),
      location: strOrNull("Location. Omit if not applicable."),
    }),
  },
  {
    name: "draft_email",
    // Confirm, not autonomous. Drafting IS proposing a send: the executor has
    // always turned this into a proposed send_email row, and the bucket it
    // declares now says the same thing, so an audit of what ran under which
    // grant cannot disagree with what actually happened.
    bucket: "confirm",
    disclosure: "app_data",
    description:
      "Draft an email in Tapas's voice. The draft is stored in the app only (never in Gmail or Outlook) and CANNOT be sent until Tapas approves it in the queue.",
    input_schema: schema({
      account: enumOf(
        SLOT_KEYS.filter((s) => s !== "icai"),
        "Account slot the mail would go from. icai cannot send."
      ),
      to: {
        type: "array",
        items: { type: "string" },
        description: "Recipient email addresses.",
      },
      cc: opt({
        type: "array",
        items: { type: "string" },
        description: "Cc addresses. Omit when there are none.",
      }),
      subject: str("Subject line."),
      body: str("Plain-text body in Tapas's voice."),
    }),
  },
  {
    name: "send_email",
    bucket: "confirm",
    disclosure: "app_data",
    description:
      "Queue an email for sending. It is NEVER sent directly: it lands in the approval queue and goes out only after Tapas approves it there.",
    input_schema: schema({
      account: enumOf(
        SLOT_KEYS.filter((s) => s !== "icai"),
        "Account slot the mail goes from. icai cannot send."
      ),
      to: {
        type: "array",
        items: { type: "string" },
        description: "Recipient email addresses.",
      },
      cc: opt({
        type: "array",
        items: { type: "string" },
        description: "Cc addresses. Omit when there are none.",
      }),
      subject: str("Subject line."),
      body: str("Plain-text body."),
    }),
  },
  {
    name: "propose_event_with_invites",
    bucket: "confirm",
    disclosure: "app_data",
    description:
      "Propose a calendar event that invites other people. It always lands in the approval queue; the invite goes out only after Tapas approves it.",
    input_schema: schema({
      account: enumOf(
        SLOT_KEYS.filter((s) => s !== "icai"),
        "Account slot whose calendar hosts the event."
      ),
      title: str("Event title."),
      date: str("Event date as YYYY-MM-DD (IST)."),
      start_time: { ...strOrNull(TIME_DESC) },
      end_time: { ...strOrNull(TIME_DESC) },
      description: strOrNull("Event description. Omit if not applicable."),
      location: strOrNull("Location. Omit if not applicable."),
      attendees: {
        type: "array",
        items: schema({
          email: str("Attendee email address."),
          name: strOrNull("Attendee name. Omit if not applicable."),
        }),
        description: "People to invite.",
      },
    }),
  },
  {
    // B18. Autonomous because nothing leaves the mailbox: the draft waits in
    // Drafts until Tapas sends it himself, and no code path here can send it.
    // Recipients, subject and attachments are deliberately NOT parameters:
    // who a reply goes to is derived from the thread in lib/assistant/
    // mailbox.ts, and the executor refuses any of them by name. It reads the
    // last message's headers to do that, so its class is mail_metadata.
    name: "save_reply_draft",
    bucket: "autonomous",
    disclosure: "mail_metadata",
    description:
      "Save a reply to an existing mail thread as a DRAFT in that mailbox's Drafts folder, for Tapas to check and send himself. Nothing is ever sent. Replies only: a thread_id from lifeos_list_inbox is required. Who it goes to and the subject are taken from the thread (the last message's sender, or with reply_all also its To and Cc, never his own address), and nothing is ever attached. Reversible with undo_action while the draft is untouched.",
    input_schema: schema({
      account: enumOf(
        MAIL_SLOTS,
        "The mailbox the thread is in. icai has no drafts."
      ),
      thread_id: str(
        "The thread_id from lifeos_list_inbox: the Gmail thread id, or for altechon the Outlook conversation id."
      ),
      body: str(
        "The reply in plain text, in Tapas's voice. Only the new words: the earlier messages are not quoted."
      ),
      reply_all: boolOrNull(
        "True to reply to everyone on the last message. Defaults to false: the sender only."
      ),
    }),
  },
  {
    name: "delete_task",
    bucket: "autonomous",
    disclosure: "app_data",
    description:
      "Delete one of Tapas's own tasks, and its reminder. Recorded in the queue and reversible with undo_action. Use update_task with status dropped when the work was abandoned but worth remembering.",
    input_schema: schema({ task_id: str("The task id from context.") }),
  },
  {
    name: "add_project",
    bucket: "autonomous",
    disclosure: "app_data",
    description: "Create a project to group related tasks under a work stream.",
    input_schema: schema({
      name: str("Project name."),
      work_stream: strOrNull(
        "Work stream name. Omit to file it under Personal."
      ),
      notes: strOrNull("Optional detail."),
    }),
  },
  {
    name: "update_note",
    bucket: "autonomous",
    disclosure: "app_data",
    description: "Change a saved note's title or body.",
    input_schema: schema({
      note_id: str("The note id."),
      title: strOrNull("New title. Omit to keep the current one."),
      body: strOrNull("New body in Markdown. Omit to keep the current one."),
      task_id: strOrNull(
        "Link the note to a task, from context. Omit to keep the current link."
      ),
      trip_id: strOrNull(
        "Link the note to a trip, from lifeos_list_trips. Omit to keep the current link."
      ),
    }),
  },
  {
    name: "delete_note",
    bucket: "autonomous",
    disclosure: "app_data",
    description:
      "Delete a saved note. Reversible: undo_action restores it.",
    input_schema: schema({ note_id: str("The note id.") }),
  },
  {
    name: "update_person",
    bucket: "autonomous",
    disclosure: "app_data",
    description:
      "Update a person record. Set verified to true only when Tapas has confirmed the address himself; that clears the unverified flag shown at send time.",
    input_schema: schema({
      person_id: str("The person id."),
      name: strOrNull("New name. Omit to keep."),
      org: strOrNull("New organisation. Omit to keep."),
      role: strOrNull("New role. Omit to keep."),
      email: strOrNull("Replace the email addresses with this one. Omit to keep."),
      phone: strOrNull("Replace the phone numbers with this one. Omit to keep."),
      context: strOrNull("How this person is known. Omit to keep."),
      verified: boolOrNull("True marks the record confirmed by Tapas."),
    }),
  },
  {
    name: "delete_person",
    bucket: "autonomous",
    disclosure: "app_data",
    description:
      "Delete a person record. Reversible: undo_action restores it.",
    input_schema: schema({ person_id: str("The person id.") }),
  },
  {
    name: "update_obligation",
    bucket: "autonomous",
    disclosure: "app_data",
    description: "Update a recurring obligation, or switch it off with active false.",
    input_schema: schema({
      obligation_id: str("The obligation id."),
      name: strOrNull("New name. Omit to keep."),
      amount: numOrNull("New amount in rupees. Omit to keep."),
      due_day: {
        type: "integer",
        description: "New day of month it falls due (1-31).",
        __optional: true,
      },
      due_month: {
        type: "integer",
        description: "New month (1-12) for yearly obligations.",
        __optional: true,
      },
      autopay: boolOrNull("Whether it is on autopay."),
      active: boolOrNull("False retires it without deleting the history."),
    }),
  },
  {
    name: "delete_obligation",
    bucket: "autonomous",
    disclosure: "app_data",
    description:
      "Delete a recurring obligation and its reminder. Reversible: undo_action restores it.",
    input_schema: schema({ obligation_id: str("The obligation id.") }),
  },
  {
    name: "add_finance_item",
    bucket: "autonomous",
    disclosure: "app_data",
    description:
      "Record an investment or deposit: a fixed deposit, mutual fund, stock, NCD or other holding. A maturity date puts one reminder on his calendar; a review date does not interrupt him and shows on Home and in the morning brief instead.",
    input_schema: schema({
      kind: enumOf(["fd", "mf", "stock", "ncd", "other"], "What kind of holding."),
      name: str("What it is called."),
      institution: strOrNull(HOLDING_WHERE_DESC),
      value: numOrNull("Current value in rupees."),
      key_date: { ...strOrNull("Maturity or review date as YYYY-MM-DD.") },
      key_date_type: enumOrNull(
        ["maturity", "review"],
        "What that date means. 'maturity' where the holding ends on a date and the money has to be redirected, which is worth interrupting him for. 'review' for anything open-ended, such as a stock or an open-ended fund, which has no maturity and would otherwise drift for years."
      ),
      notes: strOrNull("Anything worth remembering."),
    }),
  },
  {
    name: "update_finance_item",
    bucket: "autonomous",
    disclosure: "app_data",
    description:
      "Update a recorded holding: its value, where it is held, its key date or notes. Changing the key date type changes how it reminds him, so a maturity turned into a review date loses its calendar entry.",
    input_schema: schema({
      finance_item_id: str("The holding id."),
      name: strOrNull("New name. Omit to keep."),
      institution: strOrNull(HOLDING_WHERE_DESC + " Omit to keep."),
      value: numOrNull("New value in rupees. Omit to keep."),
      key_date: { ...strOrNull("New maturity or review date as YYYY-MM-DD.") },
      key_date_type: enumOrNull(
        ["maturity", "review"],
        "What that date means. Omit to keep."
      ),
      notes: strOrNull("New notes. Omit to keep."),
    }),
  },
  {
    name: "delete_finance_item",
    bucket: "autonomous",
    disclosure: "app_data",
    description:
      "Delete a recorded holding. Reversible: undo_action restores it.",
    input_schema: schema({ finance_item_id: str("The holding id.") }),
  },
  {
    name: "update_event_solo",
    bucket: "autonomous",
    disclosure: "app_data",
    description:
      "Edit an event the app created, keeping it attendee-free. Events synced from a calendar Tapas does not own cannot be edited here.",
    input_schema: schema({
      event_id: str("The event id from lifeos_list_events."),
      title: strOrNull("New title. Omit to keep."),
      date: { ...strOrNull("New date as YYYY-MM-DD (IST). Omit to keep.") },
      start_time: { ...strOrNull(TIME_DESC + " Omit to keep.") },
      end_time: { ...strOrNull(TIME_DESC + " Omit to keep.") },
      description: strOrNull("New description. Omit to keep."),
      location: strOrNull("New location. Omit to keep."),
    }),
  },
  {
    name: "delete_event",
    bucket: "autonomous",
    disclosure: "app_data",
    description:
      "Delete an event the app created. Refuses anything synced from an external calendar, since that is not the app's to remove.",
    input_schema: schema({ event_id: str("The event id.") }),
  },
  {
    name: "scan_mail",
    bucket: "autonomous",
    disclosure: "mail_body",
    description:
      "Read recent inbox metadata across the connected accounts and propose tasks from anything needing action. Never stores message bodies. Optional days (a whole number from 1 to 14, default 3) and account (one account slot name, for example icai) run a one-off catch-up: a wider window lifts the message and task caps for that call only, and every duplicate rule still applies. For a catch-up, scan one account per call so the call stays short.",
    input_schema: schema({
      days: numOrNull("Look-back window in whole days, 1 to 14. Omit for the nightly 3."),
      account: strOrNull("One account slot name to scan (taxstrategia, ca_tapasnr, altechon or icai). Omit for every connected account."),
    }),
  },
  {
    name: "undo_action",
    bucket: "autonomous",
    disclosure: "app_data",
    description:
      "Undo an assistant action that already ran, reversing what it created. Sent email cannot be undone.",
    input_schema: schema({ action_id: str("The action id from the queue history.") }),
  },
  {
    name: "reject_queued_action",
    bucket: "autonomous",
    disclosure: "app_data",
    description:
      "Discard something waiting in the approval queue, so it can never be sent. Approving remains impossible outside the app.",
    input_schema: schema({ action_id: str("The action id from the pending list.") }),
  },
  {
    name: "lookup_gst_wiki",
    bucket: "stub",
    disclosure: "none",
    description:
      "Look up Tapas's GST research wiki. Not yet connected in this version.",
    input_schema: schema({ query: str("What to look up.") }),
  },
  {
    name: "create_trip",
    bucket: "autonomous",
    disclosure: "app_data",
    description:
      "Create a trip: an AICA session, a conference, leisure or other travel. Its travel legs and expenses hang off it, and they feed the month pack Tapas invoices from. This app never produces an invoice or a bill.",
    input_schema: schema({
      purpose: enumOf(
        ["aica", "conference", "leisure", "other", "training"],
        "What the trip is for. training is a non-ICAI training, e.g. for Cygnet or another client: set work_stream to the client."
      ),
      title: str("Short trip title, e.g. AICA session, Rajkot branch."),
      work_stream: strOrNull(
        "Work stream name, e.g. ICAI, Tax Strategia, Personal. Omit to file it under Personal."
      ),
      start_date: { ...strOrNull(DATE_DESC) },
      end_date: { ...strOrNull(DATE_DESC) },
      cities: opt({
        type: "array",
        items: { type: "string" },
        description: "Cities the trip covers, in order.",
      }),
      session_label: strOrNull(
        "Short session identity read at a glance, e.g. L1D2 for AICA Level 1 Day 2, or L2D5 for Level 2 Day 5."
      ),
      session_date: {
        ...strOrNull(
          "The day the session actually runs, which is usually NOT the trip's start date: he travels the night before. YYYY-MM-DD."
        ),
      },
      bills_to: enumOrNull(
        ["icai_monthly", "chapter_aed", "none", "client"],
        "How it is billed. icai_monthly (the default) goes into the monthly claim to the ICAI AI committee. chapter_aed is an overseas chapter, invoiced separately to the chapter in AED and never on the ICAI claim. none is not billable to anyone. client is reimbursed by the client, the client being the trip's work stream (Cygnet, say). A training trip should usually be none or client."
      ),
      notes: strOrNull("Anything worth remembering about the trip."),
      hotel_arrangement: enumOrNull(
        ["branch", "self", "relative", "same_day", "client"],
        "How the accommodation is handled: branch (the ICAI branch arranges it), self (he books it, reimbursable), relative (staying with family), same_day (back the same day), client (the client books travel and hotel, so the checklist only confirms them). This decides the checklist's hotel step. Omit to let the app default it: branch, which is the norm, or same_day when the trip starts and ends on one date."
      ),
      same_journey_as: strOrNull(
        "To make this a session of an existing journey, pass the id of one of the trips already on that journey (from lifeos_list_trips). The server joins this trip to that trip's journey, or starts a journey on both when that trip had none. A journey is one continuous trip serving several engagements, e.g. Ahmedabad to Bengaluru (Cygnet) to Delhi (Cygnet) to Surat (ICAI). Omit when it is a trip of its own."
      ),
      journey_id: strOrNull(
        "A journey id taken from lifeos_list_trips (journey_id). Prefer same_journey_as, which needs no id. Omit when not part of a journey."
      ),
      with_checklist: boolOrNull(
        "Also add the standard travel checklist (book onward, book return, confirm hotel, collect receipts), dated from the trip's own dates. Defaults to false. Needs a start date."
      ),
    }),
  },
  {
    name: "update_trip",
    bucket: "autonomous",
    disclosure: "app_data",
    description:
      "Update a trip: its title, dates, how it is billed, or where it sits on the trail (planned, underway, done, billed). Undo restores the previous values.",
    input_schema: schema({
      trip_id: str("The trip id from lifeos_list_trips."),
      title: strOrNull("New title. Omit to keep the current one."),
      status: enumOrNull(
        ["planned", "booked", "underway", "done", "billed", "cancelled"],
        "Where the trip sits. Omit to keep the current one."
      ),
      start_date: { ...strOrNull(DATE_DESC + " Omit to keep.") },
      end_date: { ...strOrNull(DATE_DESC + " Omit to keep.") },
      bills_to: enumOrNull(
        ["icai_monthly", "chapter_aed", "none", "client"],
        "How it is billed: icai_monthly, chapter_aed (overseas, AED, never on the ICAI claim), none, or client (reimbursed by the client, the trip's work stream). Omit to keep."
      ),
      notes: strOrNull("New notes. Omit to keep."),
      cities: opt({
        type: "array",
        items: { type: "string" },
        description: "The cities the trip covers, in order. Replaces the whole list. Omit to keep.",
      }),
      hotel_arrangement: enumOrNull(
        ["branch", "self", "relative", "same_day", "client"],
        "How the accommodation is handled: branch, self, relative, same_day or client (the client books travel and hotel). Changing it does not rewrite checklist steps already there: call sync_trip_hotel_step for that. Omit to keep."
      ),
      same_journey_as: strOrNull(
        "To make this a session of an existing journey, pass the id of one of the trips already on that journey (from lifeos_list_trips). The server joins this trip to that trip's journey, or starts a journey on both when that trip had none. A journey is one continuous trip serving several engagements, e.g. Ahmedabad to Bengaluru (Cygnet) to Delhi (Cygnet) to Surat (ICAI). Omit when it is a trip of its own."
      ),
      journey_id: strOrNull(
        "A journey id from lifeos_list_trips, or the single word none to take this trip out of its journey. Prefer same_journey_as to join one. Omit to keep."
      ),
      session_label: strOrNull(
        "Short session identity, e.g. L1D2 for AICA Level 1 Day 2. Omit to keep."
      ),
      session_date: { ...strOrNull(DATE_DESC + " The day the session runs, not the travel start. Omit to keep.") },
    }),
  },
  {
    name: "log_trip_leg",
    bucket: "autonomous",
    disclosure: "app_data",
    description:
      "Add one journey to a trip: from, to, date and mode. Tapas's transport preference runs Vande Bharat, then Tejas, then AC sleeper, then cab; suggest in that order unless he says otherwise. Undo removes the leg again.",
    input_schema: schema({
      trip_id: str("The trip id from lifeos_list_trips."),
      from_city: str("Where the journey starts."),
      to_city: str("Where the journey ends."),
      date: str("Journey date as YYYY-MM-DD (IST)."),
      mode: enumOf(
        ["vande_bharat", "tejas", "ac_sleeper", "cab", "flight", "other"],
        "How he travels, in his order of preference."
      ),
      cost: numOrNull("Fare in rupees. Omit when it is not known yet."),
      reference: strOrNull("The PNR or booking id, at most 40 characters. Omit when there is none."),
      time: strOrNull("Departure time as HH:MM, 24-hour IST, for example 07:05. Omit when it is not known."),
    }),
  },
  {
    name: "add_trip_expense",
    bucket: "autonomous",
    disclosure: "app_data",
    description:
      "Record one expense against a trip. Mark it billable when the institute or client reimburses it; billable expenses are what the monthly claim is assembled from. Always give a receipt_ref when there is one: a billable expense without it becomes a chase at invoice time. Undo removes it.",
    input_schema: schema({
      trip_id: str("The trip id from lifeos_list_trips."),
      category: enumOf(
        ["transport", "hotel", "per_diem", "other"],
        "What kind of expense."
      ),
      amount: { type: "number", description: "Amount in rupees." },
      date: str("Date of the expense as YYYY-MM-DD (IST)."),
      billable: boolOrNull("True when it is reimbursed. Defaults to false."),
      receipt_ref: strOrNull(
        "Where the receipt lives, as a short note, e.g. 'physical file' or a link he gave. Never the document itself."
      ),
    }),
  },
  // --- B22: connector completeness -----------------------------------------
  // Edits of records that already exist, each undoable. No delete tool for a
  // trip, an expense or a project: none is added here.
  {
    name: "update_trip_expense",
    bucket: "autonomous",
    disclosure: "app_data",
    description:
      "Change one trip expense line: its receipt reference, whether it is billable, the amount, the date, the category, or which trip (session) it belongs to. Take the expense_id from lifeos_list_trip_expenses. An expense is never split: it moves whole. Undo restores the old values. There is no tool that deletes an expense.",
    input_schema: schema({
      expense_id: str("The expense id from lifeos_list_trip_expenses."),
      trip_id: strOrNull(
        "Move the expense to this trip (session), from lifeos_list_trips. It must be one of his trips. Omit to keep it where it is."
      ),
      receipt_ref: strOrNull(
        "Where the receipt lives, as a short note, e.g. 'physical file' or a link he gave. Never the document itself. Omit to keep."
      ),
      billable: boolOrNull("True when it is reimbursed. Omit to keep."),
      amount: numOrNull("Amount in rupees. Omit to keep."),
      date: strOrNull("Date of the expense as YYYY-MM-DD (IST). Omit to keep."),
      category: enumOrNull(
        ["transport", "hotel", "per_diem", "other"],
        "What kind of expense. Omit to keep."
      ),
    }),
  },
  {
    name: "update_project",
    bucket: "autonomous",
    disclosure: "app_data",
    description:
      "Change a project: its name, work stream, status or notes. Undo restores the old values. There is no tool that deletes a project: set status done or dropped instead.",
    input_schema: schema({
      project_id: str("The project id from lifeos_list_projects."),
      name: strOrNull("New name. Omit to keep."),
      work_stream: strOrNull(
        "Move it to this work stream, named exactly as it exists. An unknown name is refused with the real list. Omit to keep."
      ),
      status: enumOrNull(
        ["active", "on_hold", "done", "dropped"],
        "Where the project stands. Omit to keep."
      ),
      note: strOrNull("New notes. Omit to keep."),
    }),
  },
  {
    name: "update_work_stream",
    bucket: "autonomous",
    disclosure: "app_data",
    description:
      "Change a work stream's mail scan hint (one line, at most 200 characters, saying what mail belongs in it). The same rule as Settings. The hourly rate is Tapas's to set in Settings only. Undo restores the old hint.",
    input_schema: schema({
      name: str("The work stream's name exactly as it exists, from lifeos_list_work_streams."),
      scan_hint: strOrNull(
        "One line of plain text, at most 200 characters, telling the nightly mail scan what belongs in this stream. An empty string clears it. Omit to keep."
      ),
    }),
  },
  {
    name: "add_trip_checklist",
    bucket: "autonomous",
    disclosure: "app_data",
    description:
      "Add the standard travel checklist (book onward, book return, the hotel step, collect receipts) to a trip that does not have it yet, dated from the trip's own dates. A step the trip already carries is never added twice. Needs a start date. Undo removes the steps it added.",
    input_schema: schema({
      trip_id: str("The trip id from lifeos_list_trips."),
    }),
  },
  {
    name: "sync_trip_hotel_step",
    bucket: "autonomous",
    disclosure: "app_data",
    description:
      "Bring a trip's hotel checklist step in line with its hotel_arrangement, as the trip screen's Update the checklist button does. It only touches a step still at todo with the app's own wording; a step Tapas has worked or retitled is left alone. A step no longer wanted is dropped, never deleted. Undo puts the steps back.",
    input_schema: schema({
      trip_id: str("The trip id from lifeos_list_trips."),
    }),
  },
  {
    name: "update_trip_leg",
    bucket: "autonomous",
    disclosure: "app_data",
    description:
      "Correct one journey on a trip. leg_index is the leg's position in the legs list lifeos_list_trips returns, counting from 0. Only the fields given change. Undo restores the legs exactly as they were.",
    input_schema: schema({
      trip_id: str("The trip id from lifeos_list_trips."),
      leg_index: { type: "integer", description: "Position of the leg in lifeos_list_trips, counting from 0." },
      from_city: strOrNull("Where the journey starts. Omit to keep."),
      to_city: strOrNull("Where the journey ends. Omit to keep."),
      date: strOrNull("Journey date as YYYY-MM-DD (IST). Omit to keep."),
      mode: enumOrNull(
        ["vande_bharat", "tejas", "ac_sleeper", "cab", "flight", "other"],
        "How he travels. Omit to keep."
      ),
      ref: strOrNull("The PNR or booking id, at most 40 characters. Omit to keep."),
      time: strOrNull("Departure time as HH:MM, 24-hour IST, for example 07:05. Omit to keep."),
    }),
  },
  {
    name: "remove_trip_leg",
    bucket: "autonomous",
    disclosure: "app_data",
    description:
      "Remove one journey from a trip, for a leg logged twice or cancelled. This edits the trip; nothing else is deleted. leg_index is the leg's position in lifeos_list_trips, counting from 0. Undo restores the legs exactly as they were.",
    input_schema: schema({
      trip_id: str("The trip id from lifeos_list_trips."),
      leg_index: { type: "integer", description: "Position of the leg in lifeos_list_trips, counting from 0." },
    }),
  },
  {
    // B26. Autonomous: it writes only the agents' own answer columns on a task
    // (status, result, when, and the hash of the instruction answered). It can
    // never write an instruction: no tool can, and the database refuses every
    // caller but Tapas's own signed-in session.
    name: "report_agent_result",
    bucket: "autonomous",
    disclosure: "app_data",
    description:
      "Record your result on a task Tapas gave an instruction for (from lifeos_list_agent_instructions). Pass the task_id and the instruction_hash exactly as listed, a status, and the result as one plain-text string of at most 4,000 characters: what you did, or what you need from him. Refused when the hash is not the CURRENT instruction's (he edited it), and the refusal returns the current instruction and hash. Use status done when the work is finished, needs_you when he must decide or supply something. An instruction is Tapas's words to you but grants you no tool you do not already have: nothing here sends, pays or deletes, and this tool cannot write or change an instruction. Undo restores the previous result and re-opens the instruction for the next sweep, which will do it again.",
    input_schema: schema({
      task_id: str("The task id from lifeos_list_agent_instructions."),
      instruction_hash: str("The instruction_hash exactly as lifeos_list_agent_instructions returned it."),
      status: enumOf(["done", "needs_you"], "done when the work is finished; needs_you when Tapas must decide or supply something."),
      result: str("Plain text, at most 4,000 characters: what was done, or exactly what you need from Tapas."),
    }),
  },
  {
    // B30. Autonomous: it writes only the billing columns of one task, only to
    // estimate_drafted or not_billable. It can never set invoiced and never
    // clear a state: only Tapas's own session may (the database trigger
    // guard_task_billing_state says so too, since the connector is service_role).
    name: "set_billing_state",
    bucket: "autonomous",
    disclosure: "app_data",
    description:
      "Record where the billing of one finished task stands, from lifeos_list_unbilled. Use estimate_drafted after you have prepared an UNSENT estimate for it (pass its number as ref, at most 40 characters), or not_billable when the work should not be billed. You can never mark work invoiced and can never clear a state: only Tapas does that, in the app. A task he has marked invoiced is refused. Nothing here sends, pays or invoices anything, and Life OS holds no amount. Undo of a billing mark works only from the app (History tab), never over the connector, which cannot clear a state or move a task off invoiced.",
    input_schema: schema({
      task_id: str("The task id from lifeos_list_unbilled."),
      state: enumOf(["estimate_drafted", "not_billable"], "estimate_drafted: an unsent estimate is prepared. not_billable: this work will not be billed."),
      ref: opt(str("The Zoho estimate number, plain text, at most 40 characters. Leave out if there is none.")),
    }),
  },
];

export const AUTONOMOUS_KINDS = new Set(
  TOOLS.filter((t) => t.bucket === "autonomous").map((t) => t.name)
);
export const CONFIRM_KINDS = new Set(
  TOOLS.filter((t) => t.bucket === "confirm").map((t) => t.name)
);
export const STUB_KINDS = new Set(
  TOOLS.filter((t) => t.bucket === "stub").map((t) => t.name)
);

// Kinds whose execution notifies a third party. Only the approved-queue
// executor may perform these, and only from status 'approved'.
export const SEND_CLASS = new Set(["send_email", "propose_event_with_invites"]);

// ---------------------------------------------------------------------------
// B10: where each autonomous tool's target comes from.
//
// An autonomous grant used to be attached to the tool name alone, so any call
// to update_task ran under the autonomous bucket whatever it was pointed at.
// The grant belongs to the pair: the verb AND the thing it acts on. Every
// autonomous tool that acts on something already in existence declares here
// which argument names its target and where that target has to be found; the
// executor refuses to run one whose target does not resolve, and queues it
// for Tapas instead. A tool absent from this table creates something new and
// so has nothing to resolve.
//
// create_task's optional trip_id is deliberately not here: it is optional, so
// there is nothing to fail closed on when it is absent, and a bad one is
// refused by the foreign key before anything is written.
//
// It lives in this pure module rather than in the executor so scripts/m4.test
// can prove that no id-taking autonomous tool was left out of it.
// ---------------------------------------------------------------------------
export type TargetTable =
  | "tasks"
  | "notes"
  | "people"
  | "recurring_obligations"
  | "finance_items"
  | "events"
  | "trips"
  | "trip_expenses"
  | "projects"
  | "assistant_actions";

export interface ToolTarget {
  // The input key naming the target, e.g. "task_id".
  arg: string;
  // The word for it in the reason Tapas reads, e.g. "task".
  label: string;
  // Where the id must be found. Absent when the target is not a row.
  table?: TargetTable;
}

export const TOOL_TARGETS: Record<string, ToolTarget> = {
  update_task: { arg: "task_id", label: "task", table: "tasks" },
  set_reminder: { arg: "task_id", label: "task", table: "tasks" },
  delete_task: { arg: "task_id", label: "task", table: "tasks" },
  update_note: { arg: "note_id", label: "note", table: "notes" },
  delete_note: { arg: "note_id", label: "note", table: "notes" },
  update_person: { arg: "person_id", label: "person", table: "people" },
  delete_person: { arg: "person_id", label: "person", table: "people" },
  update_obligation: {
    arg: "obligation_id",
    label: "obligation",
    table: "recurring_obligations",
  },
  delete_obligation: {
    arg: "obligation_id",
    label: "obligation",
    table: "recurring_obligations",
  },
  update_finance_item: {
    arg: "finance_item_id",
    label: "holding",
    table: "finance_items",
  },
  delete_finance_item: {
    arg: "finance_item_id",
    label: "holding",
    table: "finance_items",
  },
  update_event_solo: { arg: "event_id", label: "event", table: "events" },
  delete_event: { arg: "event_id", label: "event", table: "events" },
  update_trip: { arg: "trip_id", label: "trip", table: "trips" },
  log_trip_leg: { arg: "trip_id", label: "trip", table: "trips" },
  add_trip_expense: { arg: "trip_id", label: "trip", table: "trips" },
  // B22. update_work_stream is not here: it names a stream, and an unknown
  // name is refused with the real list (lib/tasks/stream.ts), not queued.
  update_trip_expense: { arg: "expense_id", label: "trip expense", table: "trip_expenses" },
  update_project: { arg: "project_id", label: "project", table: "projects" },
  add_trip_checklist: { arg: "trip_id", label: "trip", table: "trips" },
  sync_trip_hotel_step: { arg: "trip_id", label: "trip", table: "trips" },
  update_trip_leg: { arg: "trip_id", label: "trip", table: "trips" },
  remove_trip_leg: { arg: "trip_id", label: "trip", table: "trips" },
  // B26. The agents' answer lands on an existing task.
  report_agent_result: { arg: "task_id", label: "task", table: "tasks" },
  // B30. The billing state lands on an existing task.
  set_billing_state: { arg: "task_id", label: "task", table: "tasks" },
  undo_action: {
    arg: "action_id",
    label: "queued action",
    table: "assistant_actions",
  },
  reject_queued_action: {
    arg: "action_id",
    label: "queued action",
    table: "assistant_actions",
  },
  // Not a row id: the account slot must name a connected account.
  add_event_solo: { arg: "account", label: "account" },
  // Not a row either: the thread must exist in that account's mailbox, asked
  // of the provider (lib/assistant/mailbox.ts threadExists).
  save_reply_draft: { arg: "thread_id", label: "mail thread" },
};

// ---------------------------------------------------------------------------
// B11: which path a tool call takes.
//
// A function of the tool NAME and nothing else. Not the actor, not the
// session, not the persona. The invariant is that unattended execution can
// never raise autonomy, and the cheapest way to keep an invariant true is a
// resolver that structurally cannot see who is asking: the browser and the
// connector reach the same answer because there is no other answer to reach.
// ---------------------------------------------------------------------------
export type ToolRoute = "stub" | "propose" | "autonomous" | "unknown";

export function routeTool(name: string): ToolRoute {
  if (STUB_KINDS.has(name)) return "stub";
  if (CONFIRM_KINDS.has(name)) return "propose";
  if (AUTONOMOUS_KINDS.has(name)) return "autonomous";
  return "unknown";
}

export function toolByName(name: string): ToolDef | undefined {
  return TOOLS.find((t) => t.name === name);
}

// The disclosure class of any tool that can be asked to run: the write
// registry, the scan pipeline's single tool, and the connector's read tools.
// An unknown name gets the most restrictive answer rather than a permissive
// default.
export function disclosureOf(name: string): ToolDisclosure {
  if (name === SCAN_TOOL.name) return SCAN_TOOL.disclosure;
  if (name === TICKET_TOOL.name) return TICKET_TOOL.disclosure;
  if (name === CAB_TOOL.name) return CAB_TOOL.disclosure;
  const read = READ_TOOL_DISCLOSURES[name as McpReadTool];
  if (read) return read;
  return toolByName(name)?.disclosure ?? "none";
}

export const STUB_REPLIES: Record<string, string> = {
  lookup_gst_wiki: "The GST wiki is not connected yet.",
};

// Belt for attack A3: even if a model smuggles an attendees-like key into a
// solo-event payload despite the schema, the executor refuses it.
export function assertNoAttendees(input: Record<string, unknown>): void {
  for (const key of Object.keys(input)) {
    const k = key.toLowerCase();
    if (k.includes("attendee") || k === "invitees" || k === "guests") {
      throw new Error(
        "add_event_solo cannot carry attendees. Use propose_event_with_invites."
      );
    }
  }
}

// Anthropic Messages API tool format.
//
// `strict` is deliberately OFF unless asked for. It makes the provider compile
// a grammar for the tool set, which carries hard structural limits: at most 16
// union-typed and at most 24 optional parameters across all tools. This tool
// set has 202 parameters, 131 of them optional (B28 census; it was 147 and 92 at M8, 60 and 31
// when M4 wrote this line), so strict mode refuses the whole
// request. Nothing about the security model depends on it: every argument is
// validated server-side in lib/assistant/execute.ts (recipients parsed and
// checked, attendee keys refused, required fields enforced), and no tool can
// execute a send without an approved queue item regardless of what the model
// emits. Strict would only save the model from malformed arguments, which the
// executor already rejects with a readable message.
export function anthropicTools(
  defs: LlmTool[] = TOOLS,
  strict = false
): Array<{
  name: string;
  description: string;
  input_schema: ToolSchema;
  strict?: boolean;
}> {
  return defs.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.input_schema,
    ...(strict ? { strict: true } : {}),
  }));
}

// Parameter census, used by the tests and by the health check to explain why
// strict mode is off.
export function schemaStats(defs: ToolDef[] = TOOLS): {
  parameters: number;
  optional: number;
  unions: number;
} {
  let parameters = 0;
  let optional = 0;
  let unions = 0;
  for (const t of defs) {
    const s = t.input_schema as unknown as {
      properties: Record<string, unknown>;
      required?: string[];
    };
    const keys = Object.keys(s.properties ?? {});
    parameters += keys.length;
    optional += keys.filter((k) => !(s.required ?? []).includes(k)).length;
    const walk = (n: unknown): void => {
      if (!n || typeof n !== "object") return;
      if (Array.isArray(n)) return n.forEach(walk);
      const o = n as Record<string, unknown>;
      if (Array.isArray(o.type) || o.anyOf || o.oneOf) unions += 1;
      Object.values(o).forEach(walk);
    };
    walk(t.input_schema);
  }
  return { parameters, optional, unions };
}

// ---------------------------------------------------------------------------
// MCP connector surface. The write tools are the assistant's own registry
// minus the stubs, so an outside model (Claude, ChatGPT) inherits the exact
// same buckets: autonomous runs and is undoable, confirm only ever queues.
// Approving, rejecting, executing and undoing are deliberately NOT here;
// those stay owner-session acts inside the app.
// ---------------------------------------------------------------------------
export const MCP_READ_TOOLS = [
  "lifeos_get_house_rules",
  "lifeos_get_context",
  "lifeos_list_tasks",
  "lifeos_list_events",
  "lifeos_list_notes",
  "lifeos_list_people",
  "lifeos_list_obligations",
  "lifeos_list_finance_items",
  "lifeos_list_projects",
  "lifeos_list_trips",
  "lifeos_list_pending_actions",
  "lifeos_list_action_history",
  "lifeos_list_inbox",
  "lifeos_read_mail_thread",
  // B22.
  "lifeos_get_month_pack",
  "lifeos_list_trip_expenses",
  "lifeos_get_last_brief",
  "lifeos_list_scan_runs",
  "lifeos_list_work_streams",
  "lifeos_search",
  "lifeos_report_lapsed_tasks",
  "lifeos_report_premature_tasks",
  "lifeos_read_mail_attachment",
  // B26.
  "lifeos_list_agent_instructions",
  // B30.
  "lifeos_list_unbilled",
] as const;

export type McpReadTool = (typeof MCP_READ_TOOLS)[number];

// The name of the house-rules tool, in one place, because the disclosure gate,
// the connector surface and the audit row all have to mean the same tool.
export const HOUSE_RULES_TOOL = "lifeos_get_house_rules";

// What each read tool is entitled to SEE. A write tool carries its class on
// its own ToolDef; the read surface is a list of names, so it carries the same
// declaration here. The record is keyed by the read-tool union, so a new read
// tool does not compile until somebody has said what it may see, and exactly
// one entry may say 'persona'.
export const READ_TOOL_DISCLOSURES: Record<McpReadTool, ToolDisclosure> = {
  lifeos_get_house_rules: "persona",
  lifeos_get_context: "app_data",
  lifeos_list_tasks: "app_data",
  lifeos_list_events: "app_data",
  lifeos_list_notes: "app_data",
  lifeos_list_people: "app_data",
  lifeos_list_obligations: "app_data",
  lifeos_list_finance_items: "app_data",
  lifeos_list_projects: "app_data",
  lifeos_list_trips: "app_data",
  lifeos_list_pending_actions: "app_data",
  lifeos_list_action_history: "app_data",
  // B18. Both see message text: the thread read returns whole bodies, and the
  // inbox list returns snippets and Graph body previews, which are body text
  // whatever a description calls them (the same reason scan_mail is
  // mail_body). Tapas approved, by name, bodies of these three mailboxes
  // reaching an outside model under this class (the B18 brief, 26 September
  // 2026). Still no class for document or attachment content.
  lifeos_list_inbox: "mail_body",
  lifeos_read_mail_thread: "mail_body",
  // B22. Records Life OS holds. The brief, the search and the reports carry
  // task titles, some from scanned mail: rows the app owns, flagged untrusted
  // where they came from mail.
  lifeos_get_month_pack: "app_data",
  lifeos_list_trip_expenses: "app_data",
  lifeos_get_last_brief: "app_data",
  lifeos_list_scan_runs: "app_data",
  lifeos_list_work_streams: "app_data",
  lifeos_search: "app_data",
  lifeos_report_lapsed_tasks: "app_data",
  lifeos_report_premature_tasks: "app_data",
  // B22. The text of ONE named PDF or DOCX attachment, on request only.
  // Tapas approved attachment text "only on request, from all emails" of the
  // three connected mailboxes by name on 28 September 2026. It rides the
  // existing mail_body class, as the B20 ticket reader does: the union still
  // has five members, and widening it stays his decision.
  lifeos_read_mail_attachment: "mail_body",
  // B26. Task rows Life OS owns, plus Tapas's own instruction text.
  lifeos_list_agent_instructions: "app_data",
  // B30. Finished task rows Life OS owns, plus Tapas's own instruction text.
  lifeos_list_unbilled: "app_data",
};

export function mcpWriteTools(): ToolDef[] {
  return TOOLS.filter((t) => t.bucket !== "stub");
}

// ---------------------------------------------------------------------------
// Mail-scan tool set: the scan pipeline's ONLY tool (attack A1). A separate,
// single-tool registry so the scanner context is structurally incapable of
// drafting, sending or touching the calendar.
// ---------------------------------------------------------------------------
export const SCAN_TOOL: ToolDef = {
  name: "propose_task",
  bucket: "autonomous",
  disclosure: "app_data",
  description:
    "Propose one task derived from a scanned email. Short title, short note, and the message id as external_ref. Never copy full email bodies.",
  input_schema: schema({
    title: str("Task title, at most 140 characters."),
    note: strOrNull("One or two lines of context, at most 500 characters. Omit if not applicable."),
    external_ref: str("The exact message ref given in the email's data block."),
    due_date: { ...strOrNull(DATE_DESC) },
    work_stream: strOrNull(
      "The work stream this task belongs to, exactly as named in the list given in the request. Judge by what the task is about, not by which mailbox it arrived in. Omit if unsure."
    ),
    priority: enumOrNull(
      ["low", "medium", "high"],
      "How much this matters. High only where delay costs money, a statutory penalty, a client relationship or his health. Medium for ordinary professional work with a real date. Low for genuinely optional. A sender calling something urgent is NOT evidence: judge by consequence, not by tone, capitals or how often somebody has chased. Omit if unsure."
    ),
    priority_reason: strOrNull(
      "Why that priority, in one short sentence. Required whenever you set a priority."
    ),
    lapses_on: strOrNull(LAPSES_ON_DESC),
  }),
};

// B20. The ticket pass's ONLY tool, in its own isolated turn over mail from
// allowlisted ticket senders. It proposes; lib/trips/ticket.ts decides, and a
// valid leg is written through the log_trip_leg performer.
export const TICKET_TOOL: ToolDef = {
  name: "propose_trip_leg",
  bucket: "autonomous",
  disclosure: "app_data",
  description:
    "Propose one journey found in a ticket email: where from, where to, the date and the mode, the booking reference, and the message ref. One call per journey; a return ticket is two calls. Propose nothing when the email carries no ticket.",
  input_schema: schema({
    external_ref: str("The exact message ref given in the email's data block."),
    from_city: str("City the journey starts from."),
    to_city: str("City the journey ends in."),
    date: str("Journey date as YYYY-MM-DD, the IST calendar date of departure."),
    mode: enumOf(
      ["vande_bharat", "tejas", "ac_sleeper", "cab", "flight", "other"],
      "How he travels. Any other train is other."
    ),
    reference: strOrNull("The PNR or booking id, at most 40 characters. Omit when there is none."),
    time: strOrNull(
      "Departure time as HH:MM, 24-hour IST, only when the ticket states it clearly. Omit when it does not."
    ),
  }),
};

// B21. The cab receipt pass's ONLY tool, in its own isolated turn over mail
// from the cab receipt allowlist. It proposes; lib/trips/cab.ts decides, and a
// valid ride is written through the add_trip_expense performer.
export const CAB_TOOL: ToolDef = {
  name: "propose_cab_expense",
  bucket: "autonomous",
  disclosure: "app_data",
  description:
    "Propose one cab ride found in a receipt: its IST date and time, the provider, a short from and to area, the total paid in rupees, the booking or trip id, and the message ref. One call per ride; an invoice listing several rides is several calls. Propose nothing when there is no ride, or when the rides cannot be told apart.",
  input_schema: schema({
    external_ref: str("The exact message ref given in the email's data block."),
    provider: enumOf(["uber", "ola", "rapido", "bharat_taxi"], "Who ran the ride."),
    ride_date: str("Date of the ride as YYYY-MM-DD, the IST calendar date."),
    ride_time: str("Start time of the ride as HH:MM, 24-hour IST."),
    from_area: strOrNull(
      "Where the ride started, as a short area such as Airport, Hotel or Railway Station. Never a street address, house number, pin code or phone number. Omit if unclear."
    ),
    to_area: strOrNull("Where the ride ended, in the same short form. Omit if unclear."),
    amount: { type: "number", description: "Total paid for this ride in rupees." },
    booking_id: strOrNull("The booking, trip or CRN id, at most 40 characters. Omit when there is none."),
  }),
};

// ---------------------------------------------------------------------------
// Registry self-check, at import time. TypeScript already refuses a bad
// disclosure class, but a cast or a hand-edited build output would not be
// caught by the compiler, and this registry is the security boundary. A bad
// registry stops the process rather than serving one request under it.
// ---------------------------------------------------------------------------
for (const t of [...TOOLS, SCAN_TOOL, TICKET_TOOL, CAB_TOOL]) {
  if (!(TOOL_DISCLOSURES as readonly string[]).includes(t.disclosure)) {
    throw new Error(
      `Tool ${t.name} has disclosure "${t.disclosure}", which is not one of ${TOOL_DISCLOSURES.join(", ")}.`
    );
  }
}
