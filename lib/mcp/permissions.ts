// One capability contract for consent, discovery and both MCP transports.
export interface CapabilitySet {
  read: boolean;
  write: boolean;
  mail_body: boolean;
  attachments: boolean;
  persona: boolean;
  finance: boolean;
  mailboxes: string[] | null;
  work_streams: string[] | null;
}
export const CAPABILITY_DESCRIPTIONS = {
  read: { label: "Read app records", description: "Tasks, notes, people, projects, trips and calendar records, including imported text." },
  write: { label: "Change app records", description: "Create, edit and delete private records, save mailbox drafts and queue proposals. Sending and guest calendar changes still require approval in Life OS." },
  mail_body: { label: "Read mailbox content", description: "Inbox, email threads and mail scans from the selected mailboxes." },
  attachments: { label: "Read attachments", description: "Text from explicitly requested PDF and Word mail attachments." },
  persona: { label: "Read house rules", description: "Your active persona and personal assistant instructions. Each disclosure is audited." },
  finance: { label: "Read and change financial records", description: "Financial items, obligations, trip expenses, billing and work-hour summaries; changes also require Change app records." },
} as const;
export const DEFAULT_CAPABILITIES: CapabilitySet = { read: true, write: false, mail_body: false, attachments: false, persona: false, finance: false, mailboxes: null, work_streams: null };
export const ALL_CAPABILITIES: CapabilitySet = { read: true, write: true, mail_body: true, attachments: true, persona: true, finance: true, mailboxes: null, work_streams: null };
export function normalizeCapabilities(value: unknown): CapabilitySet | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  const result = { ...DEFAULT_CAPABILITIES };
  for (const key of ["read", "write", "mail_body", "attachments", "persona", "finance"] as const) {
    if (typeof v[key] !== "boolean") return null;
    result[key] = v[key];
  }
  for (const key of ["mailboxes", "work_streams"] as const) {
    if (v[key] === null) result[key] = null;
    else if (Array.isArray(v[key]) && v[key].length <= 50 && v[key].every((s: unknown) => typeof s === "string" && s.length > 0 && s.length <= 200)) result[key] = [...new Set(v[key] as string[])];
    else return null;
  }
  return result;
}
const MAIL = new Set(["list_inbox", "read_mail_thread", "read_mail_attachment", "scan_mail", "start_scan_job", "send_email", "draft_email", "save_reply_draft"]);
const AGGREGATE = new Set(["get_context", "search", "get_last_brief", "list_pending_actions", "list_action_history", "undo_action", "reject_queued_action"]);
const FINANCE = /finance|obligation|expense|month_pack|unbilled|billing|hours/;
// Existing record APIs cannot consistently filter every join by mailbox/work
// stream. Fail closed for narrowed connections instead of filtering after disclosure.
export function capabilityAllows(c: CapabilitySet, tool: string, write: boolean, input?: Record<string, unknown>): boolean {
  const name = tool.replace(/^lifeos_/, "");
  if (!c.read || (write && !c.write)) return false;
  if (name === "get_house_rules") return c.persona;
  if (FINANCE.test(name) && !c.finance) return false;
  if (!c.finance && input && hasFinanceFields(input)) return false;
  if (["read_mail_thread", "list_inbox", "scan_mail", "start_scan_job"].includes(name) && !c.mail_body) return false;
  if (name === "read_mail_attachment" && (!c.attachments || !c.mail_body)) return false;
  if (AGGREGATE.has(name) && (!c.finance || !c.mail_body || !c.persona || c.mailboxes !== null || c.work_streams !== null)) return false;
  if (c.work_streams !== null && !MAIL.has(name) && !["list_tasks", "preview_patch", "commit_previews", "health", "connection_activity", "job_status", "job_cancel", "job_results", "operation_status"].includes(name)) return false;
  if (c.mailboxes !== null) {
    if (!MAIL.has(name) && !["health", "connection_activity", "job_status", "job_cancel", "job_results", "operation_status"].includes(name)) return false;
    if (MAIL.has(name) && input && (typeof input.account !== "string" || !c.mailboxes.includes(input.account))) return false;
  }
  // Scans classify work across streams; cannot honor a narrowed stream scope.
  if (["scan_mail", "start_scan_job"].includes(name) && (c.work_streams !== null || !c.attachments || !c.finance)) return false;
  return true;
}
function hasFinanceFields(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(hasFinanceFields);
  return !!value && typeof value === "object" && Object.entries(value).some(([key, child]) => /(bill|amount|rate|principal|valuation|hours|cost|expense|value)/i.test(key) || hasFinanceFields(child));
}
export interface McpContext { clientId: string; userId: string; capabilities: CapabilitySet }
