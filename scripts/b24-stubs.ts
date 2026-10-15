// B24 test helper: in-memory stand-ins for everything the mail scan reaches
// out to (mailboxes, the model, task writes, Supabase). Synthetic data only.
// One module stands in for several "@/..." imports; each importer takes only
// the names it needs (see b24-loader.mjs).

export interface FakeMail {
  id: string;
  from: string;
  subject: string;
  date: string;
  snippet: string;
  threadId: string;
}

export const state = {
  mails: [] as FakeMail[],
  listerCalls: [] as { days: number; messages: number }[],
  llmCalls: 0,
  // What the "model" does: given the refs in the prompt, return tool calls,
  // or throw.
  llm: (() => ({ text: "", calls: [], stop: "end" })) as (refs: string[]) => { text: string; calls: unknown[]; stop: string },
  tasks: [] as Record<string, unknown>[],
  audit: [] as { action: string; ts: string; meta: unknown }[],
  scanClaim: null as null | { run_id: string; status: string },
  scanSequence: 0,
  cronRuns: new Map<string, { run_id: string; status: string }>(),
  cronRpcError: null as string | null,
  cronSequence: 0,
  inserts: [] as { table: string; row: Record<string, unknown> }[],
};

export function resetState(): void {
  state.mails = [];
  state.listerCalls = [];
  state.llmCalls = 0;
  state.tasks = [];
  state.audit = [];
  state.inserts = [];
  state.scanClaim = null;
  state.scanSequence = 0;
  state.cronRuns.clear();
  state.cronRpcError = null;
  state.cronSequence = 0;
}

// --- fake Supabase -----------------------------------------------------------
class Query {
  private cols = "";
  private head = false;
  private eqs: [string, unknown][] = [];
  private ins: [string, unknown[]][] = [];
  private likes: string[] = [];
  private table: string;
  constructor(table: string) {
    this.table = table;
  }
  select(cols?: string, opts?: { head?: boolean }) {
    this.cols = cols ?? "";
    this.head = !!opts?.head;
    return this;
  }
  eq(c: string, v: unknown) { this.eqs.push([c, v]); return this; }
  neq() { return this; }
  in(c: string, v: unknown[]) { this.ins.push([c, v]); return this; }
  or() { return this; }
  gte() { return this; }
  like(_c: string, pattern: string) { this.likes.push(pattern.replace(/%/g, "")); return this; }
  not() { return this; }
  order() { return this; }
  limit() { return this; }
  maybeSingle() { return this; }
  single() { return this; }
  insert(row: Record<string, unknown>) {
    state.inserts.push({ table: this.table, row });
    if (this.table === "audit_log") {
      state.audit.push({ action: String(row.action), ts: new Date().toISOString(), meta: row.meta });
    }
    return this;
  }
  then(resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) {
    return Promise.resolve(this.exec()).then(resolve, reject);
  }
  private exec(): { data: unknown; count?: number; error: null } {
    const slot = this.eqs.find(([c]) => c === "slot")?.[1];
    const action = this.eqs.find(([c]) => c === "action")?.[1];
    if (this.table === "accounts") {
      const rows = [
        { id: "acc-ca", slot: "ca_tapasnr", provider: "google", status: "connected", connect_mode: "direct", email: "owner@example.test" },
        { id: "acc-icai", slot: "icai", provider: "google", status: "connected", connect_mode: "direct", email: "owner@icai.example.test" },
      ];
      return { data: slot ? rows.filter((r) => r.slot === slot) : rows, error: null };
    }
    if (this.table === "work_streams") {
      return {
        data: ["Personal", "ICAI", "Tax Strategia", "Altechon"].map((name, i) => ({ id: `ws${i}`, name, scan_hint: null })),
        error: null,
      };
    }
    if (this.table === "audit_log") {
      const wanted = this.ins.find(([c]) => c === "action")?.[1] as string[] | undefined;
      const rows = state.audit.filter((r) => (action ? r.action === action : wanted ? wanted.includes(r.action) : true));
      return { data: rows, error: null };
    }
    if (this.table === "tasks") {
      if (this.head) {
        const pat = this.likes[0] ?? "";
        return { data: null, count: state.tasks.filter((t) => String(t.external_ref).includes(pat)).length, error: null };
      }
      if (this.cols.includes("external_thread")) {
        return { data: state.tasks.map((t) => ({ external_thread: t.external_thread, source_key: t.source_key, created_at: t.created_at })), error: null };
      }
      if (this.cols.includes("external_ref")) {
        const refs = (this.ins.find(([c]) => c === "external_ref")?.[1] ?? []) as string[];
        return { data: state.tasks.filter((t) => refs.includes(String(t.external_ref))).map((t) => ({ external_ref: t.external_ref })), error: null };
      }
      return { data: state.tasks.map((t) => ({ title: t.title, status: "inbox", created_at: t.created_at })), error: null };
    }
    return { data: [], error: null };
  }
}

export const fakeSupabase = {
  from: (table: string) => new Query(table),
  async rpc(name: string, args: Record<string, unknown>) {
    if (state.cronRpcError === name) return { data: null, error: { message: "Injected RPC failure" } };
    if (name === "claim_scan_execution") {
      if (state.scanClaim && state.scanClaim.status !== "released") {
        return { data: { ...state.scanClaim, claimed: false }, error: null };
      }
      state.scanClaim = { run_id: `scan-${++state.scanSequence}`, status: "running" };
      return { data: { ...state.scanClaim, claimed: true }, error: null };
    }
    if (name === "release_scan_execution") {
      const claim = state.scanClaim;
      const released = !!claim && claim.run_id === args.p_run_id && claim.status === "running";
      if (released) claim.status = "released";
      return { data: released, error: null };
    }
    const key = `${args.p_user_id}:${args.p_job}:${args.p_ist_date}`;
    let row = state.cronRuns.get(key);
    const stamp = (action: string, extra = {}) => state.audit.push({
      action, ts: new Date().toISOString(),
      meta: { ...extra, ist_date: args.p_ist_date, run_id: row!.run_id },
    });
    if (name === "claim_cron_run") {
      if (row && row.status !== "failed") return { data: { ...row, claimed: false }, error: null };
      row = { run_id: `run-${++state.cronSequence}`, status: "running" };
      state.cronRuns.set(key, row);
      stamp(`cron_${args.p_job}_started`);
      return { data: { ...row, claimed: true }, error: null };
    }
    if (!row || row.run_id !== args.p_run_id) return { data: false, error: null };
    if (name === "mark_cron_dispatch") {
      if (row.status !== "running") return { data: false, error: null };
      row.status = "uncertain";
      return { data: true, error: null };
    }
    if (name === "finish_cron_run") {
      if (row.status !== "running" && !(row.status === "uncertain" && args.p_status !== "failed")) {
        return { data: false, error: null };
      }
      row.status = String(args.p_status);
      stamp(`cron_${args.p_job}${row.status === "succeeded" ? "" : `_${row.status}`}`, args.p_result as object);
      return { data: true, error: null };
    }
    throw new Error(`Unexpected RPC ${name}`);
  },
};

// --- "@/lib/assistant/actor" -------------------------------------------------
export async function cookieActor() {
  return { supabase: fakeSupabase, userId: "user-1", origin: "owner_session", job: null };
}
export async function serviceActor(job: string) {
  return { supabase: fakeSupabase, userId: "user-1", origin: "service", job };
}

// --- "@/lib/assistant/settings", pdf-text, execute ---------------------------
export async function loadLlmOverride() {
  return undefined;
}
export async function pdfText() {
  return "";
}
export async function logScannedTripLeg() {}
export async function logScannedCabExpense() {}

// --- "@/lib/assistant/mail" --------------------------------------------------
export function mailRequest() {
  return async () => new Response("{}");
}
export async function listRecentGmail(_id: string, window: { days: number; messages: number }) {
  state.listerCalls.push({ days: window.days, messages: window.messages });
  return state.mails.slice(0, window.messages);
}
export const listRecentGraph = listRecentGmail;

// --- "@/lib/assistant/llm" ---------------------------------------------------
export async function runLlmTurn(req: { conv: { text?: string }[] }) {
  state.llmCalls += 1;
  const text = String(req.conv[0]?.text ?? "");
  const refs = [...new Set(text.match(/gmail:[a-z_]+:m\d+/g) ?? [])];
  return state.llm(refs);
}

// --- "@/lib/tasks/write" -----------------------------------------------------
export async function createTask(_s: unknown, _u: string, input: Record<string, unknown>) {
  state.tasks.push({ ...input, created_at: new Date().toISOString() });
  return { ok: true as const, id: `task-${state.tasks.length}` };
}
