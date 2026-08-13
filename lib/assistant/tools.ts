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
// Structurally absent, deliberately: document-content tools, credential tools,
// payment tools, deletion of external data the app did not create, generic
// SQL/rpc, and any tool that mutates assistant_actions.status.
//
// Pure module: no server imports, so the offline suite (scripts/m4.test.ts)
// can prove the registry shape.

export type ToolBucket = "autonomous" | "confirm" | "stub";

export type ToolSchema = { type: "object" } & Record<string, unknown>;

export interface ToolDef {
  name: string;
  description: string;
  input_schema: ToolSchema;
  bucket: ToolBucket;
}

// Strict-mode friendly schema helper: every property required, optionality
// expressed as nullable types, additionalProperties always false.
function schema(
  props: Record<string, unknown>,
  required?: string[]
): ToolSchema {
  return {
    type: "object" as const,
    properties: props,
    required: required ?? Object.keys(props),
    additionalProperties: false,
  };
}

const str = (desc: string) => ({ type: "string", description: desc });
const strOrNull = (desc: string) => ({
  type: ["string", "null"],
  description: desc,
});
const boolOrNull = (desc: string) => ({
  type: ["boolean", "null"],
  description: desc,
});
const numOrNull = (desc: string) => ({
  type: ["number", "null"],
  description: desc,
});
const enumOf = (values: string[], desc: string) => ({
  type: "string",
  enum: values,
  description: desc,
});
const enumOrNull = (values: string[], desc: string) => ({
  type: ["string", "null"],
  enum: [...values, null],
  description: desc,
});

const DATE_DESC = "Date as YYYY-MM-DD (IST calendar date), or null.";
const TIME_DESC = "Time of day as HH:MM in 24 hour IST, or null.";

// The four connected account slots the assistant may act through.
const SLOT_KEYS = ["taxstrategia", "ca_tapasnr", "altechon", "icai"];

export const TOOLS: ToolDef[] = [
  {
    name: "create_task",
    bucket: "autonomous",
    description:
      "Create a task on Tapas's own list. Executes immediately and is undoable from the queue history.",
    input_schema: schema({
      title: str("Short task title."),
      note: strOrNull("Optional extra detail."),
      work_stream: strOrNull(
        "Work stream name, e.g. ICAI, Tax Strategia, Altechon, Cygnet, Personal. Null defaults to Personal."
      ),
      due_date: { ...strOrNull(DATE_DESC) },
      priority: enumOrNull(["low", "medium", "high"], "Task priority."),
      billable: boolOrNull("Whether the work is billable."),
    }),
  },
  {
    name: "update_task",
    bucket: "autonomous",
    description:
      "Update an existing task (title, note, status, priority, due date). Undo restores the previous values.",
    input_schema: schema({
      task_id: str("The task id from context."),
      title: strOrNull("New title, or null to keep."),
      note: strOrNull("New note, or null to keep."),
      status: enumOrNull(
        ["inbox", "todo", "doing", "done", "dropped"],
        "New status, or null to keep."
      ),
      priority: enumOrNull(["low", "medium", "high"], "New priority, or null to keep."),
      due_date: { ...strOrNull(DATE_DESC + " Null keeps the current due date.") },
    }),
  },
  {
    name: "set_reminder",
    bucket: "autonomous",
    description:
      "Set or move the due date and reminder offsets of a task. Reminders are popup notifications on an attendee-free calendar event; nothing is sent to anyone.",
    input_schema: schema({
      task_id: str("The task id from context."),
      due_date: str("Due date as YYYY-MM-DD (IST)."),
      remind_days: {
        type: ["array", "null"],
        items: { type: "integer" },
        description: "Days before due to remind, e.g. [7,3,1,0]. Null keeps current.",
      },
    }),
  },
  {
    name: "add_note",
    bucket: "autonomous",
    description: "Save a note (meeting, decision, idea or reference) in the app.",
    input_schema: schema({
      type: enumOf(["meeting", "decision", "idea", "reference"], "Note type."),
      title: str("Note title."),
      body: strOrNull("Note body in Markdown, or null."),
    }),
  },
  {
    name: "add_person",
    bucket: "autonomous",
    description:
      "Save a person record. Records created by the assistant are flagged unverified until Tapas confirms them; unverified recipients are highlighted at send time.",
    input_schema: schema({
      name: str("Full name."),
      org: strOrNull("Organisation, or null."),
      role: strOrNull("Role or designation, or null."),
      email: strOrNull("Email address, or null."),
      phone: strOrNull("Phone number, or null."),
      context: strOrNull("How this person is known, or null."),
    }),
  },
  {
    name: "add_obligation",
    bucket: "autonomous",
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
      amount: numOrNull("Amount in rupees, or null if variable."),
      frequency: enumOf(
        ["monthly", "bi_monthly", "quarterly", "half_yearly", "yearly"],
        "How often it falls due."
      ),
      due_day: { type: "integer", description: "Day of month it falls due (1-31)." },
      due_month: {
        type: ["integer", "null"],
        description: "Month (1-12) for yearly obligations, else null.",
      },
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
    description:
      "Add a calendar event with ZERO attendees to one of Tapas's own calendars (the account's write-back calendar). Nothing is sent to anyone. For any event involving other people use propose_event_with_invites instead.",
    input_schema: schema({
      account: enumOf(
        SLOT_KEYS.filter((s) => s !== "icai"),
        "Account slot whose write-back calendar receives the event. icai is read-only."
      ),
      title: str("Event title."),
      date: str("Event date as YYYY-MM-DD (IST)."),
      start_time: { ...strOrNull(TIME_DESC + " Null makes it an all-day event.") },
      end_time: { ...strOrNull(TIME_DESC) },
      description: strOrNull("Event description, or null."),
      location: strOrNull("Location, or null."),
    }),
  },
  {
    name: "draft_email",
    bucket: "autonomous",
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
      cc: {
        type: ["array", "null"],
        items: { type: "string" },
        description: "Cc addresses, or null.",
      },
      subject: str("Subject line."),
      body: str("Plain-text body in Tapas's voice."),
    }),
  },
  {
    name: "send_email",
    bucket: "confirm",
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
      cc: {
        type: ["array", "null"],
        items: { type: "string" },
        description: "Cc addresses, or null.",
      },
      subject: str("Subject line."),
      body: str("Plain-text body."),
    }),
  },
  {
    name: "propose_event_with_invites",
    bucket: "confirm",
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
      description: strOrNull("Event description, or null."),
      location: strOrNull("Location, or null."),
      attendees: {
        type: "array",
        items: schema({
          email: str("Attendee email address."),
          name: strOrNull("Attendee name, or null."),
        }),
        description: "People to invite.",
      },
    }),
  },
  {
    name: "lookup_gst_wiki",
    bucket: "stub",
    description:
      "Look up Tapas's GST research wiki. Not yet connected in this version.",
    input_schema: schema({ query: str("What to look up.") }),
  },
  {
    name: "log_trip_leg",
    bucket: "stub",
    description: "Log a travel leg of a trip. Arrives with the Trips milestone.",
    input_schema: schema({ summary: str("What to log.") }),
  },
  {
    name: "add_trip_expense",
    bucket: "stub",
    description: "Record a trip expense. Arrives with the Trips milestone.",
    input_schema: schema({ summary: str("What to record.") }),
  },
  {
    name: "create_bill_draft",
    bucket: "stub",
    description: "Draft a bill. Arrives with the Trips milestone.",
    input_schema: schema({ summary: str("What to draft.") }),
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

export function toolByName(name: string): ToolDef | undefined {
  return TOOLS.find((t) => t.name === name);
}

export const STUB_REPLIES: Record<string, string> = {
  lookup_gst_wiki: "The GST wiki is not connected yet.",
  log_trip_leg: "Trip logging arrives with the Trips milestone.",
  add_trip_expense: "Trip expenses arrive with the Trips milestone.",
  create_bill_draft: "Bill drafting arrives with the Trips milestone.",
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

// Anthropic Messages API tool format, strict on every schema.
export function anthropicTools(defs: ToolDef[] = TOOLS): Array<{
  name: string;
  description: string;
  input_schema: ToolSchema;
  strict: boolean;
}> {
  return defs.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.input_schema,
    strict: true,
  }));
}

// ---------------------------------------------------------------------------
// Mail-scan tool set: the scan pipeline's ONLY tool (attack A1). A separate,
// single-tool registry so the scanner context is structurally incapable of
// drafting, sending or touching the calendar.
// ---------------------------------------------------------------------------
export const SCAN_TOOL: ToolDef = {
  name: "propose_task",
  bucket: "autonomous",
  description:
    "Propose one task derived from a scanned email. Short title, short note, and the message id as external_ref. Never copy full email bodies.",
  input_schema: schema({
    title: str("Task title, at most 140 characters."),
    note: strOrNull("One or two lines of context, at most 500 characters, or null."),
    external_ref: str("The exact message ref given in the email's data block."),
    due_date: { ...strOrNull(DATE_DESC) },
  }),
};
