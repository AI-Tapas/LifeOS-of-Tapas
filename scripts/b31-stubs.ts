// B31 test helper: an in-memory Supabase with just enough query surface for the
// alert, capture and task paths, a mocked web-push, and no-op stand-ins for
// everything that would reach a mailbox, a calendar or a network. Synthetic
// data only. One module stands in for several imports (see b31-loader.mjs).

type Row = Record<string, unknown>;

export const db: Record<string, Row[]> = {};
export function resetDb(): void {
  for (const k of Object.keys(db)) delete db[k];
  for (const t of [
    "tasks",
    "assistant_actions",
    "audit_log",
    "work_streams",
    "projects",
    "accounts",
    "push_subscriptions",
    "capture_tokens",
  ]) {
    db[t] = [];
  }
  db.work_streams.push({ id: "ws-personal", user_id: OWNER, name: "Personal" });
  push.calls.length = 0;
  push.statusFor = {};
}

let seq = 0;
export const OWNER = "user-1";

// A real client hands back copies, so a row read before a write is not changed
// by it.
const clone = (r: Row | undefined): Row | null => (r ? { ...r } : null);
const STAMP: Record<string, string> = { tasks: "created_at", audit_log: "ts" };

class Query {
  private table: string;
  private filters: ((r: Row) => boolean)[] = [];
  private patch: Row | null = null;
  private pendingInsert: Row | null = null;
  constructor(table: string) {
    this.table = table;
  }
  select() { return this; }
  eq(c: string, v: unknown) { this.filters.push((r) => r[c] === v); return this; }
  in(c: string, v: unknown[]) { this.filters.push((r) => v.includes(r[c])); return this; }
  not(c: string, _op: string, v: unknown) { this.filters.push((r) => r[c] !== v && !(v === null && r[c] == null)); return this; }
  neq(c: string, v: unknown) { this.filters.push((r) => r[c] !== v); return this; }
  order() { return this; }
  limit() { return this; }
  gte(c: string, v: string) { this.filters.push((r) => String(r[c] ?? "") >= v); return this; }
  gt(c: string, v: string) { this.filters.push((r) => String(r[c] ?? "") > v); return this; }
  or() { return this; }
  range() { return this; }
  is(c: string, v: unknown) { this.filters.push((r) => (v === null ? r[c] == null : r[c] === v)); return this; }
  update(patch: Row) { this.patch = patch; return this; }
  insert(row: Row) { this.pendingInsert = row; return this; }
  delete() { this.patch = { __delete: true }; return this; }
  maybeSingle() { return this.run(true); }
  single() { return this.run(true); }
  then(resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) {
    return Promise.resolve(this.run(false)).then(resolve, reject);
  }
  private run(single: boolean): { data: unknown; error: null | { message: string }; count?: number } {
    const rows = (db[this.table] ??= []);
    if (this.pendingInsert) {
      const stamp = STAMP[this.table];
      const row = {
        id: `${this.table}-${++seq}`,
        ...(stamp ? { [stamp]: new Date().toISOString() } : {}),
        ...this.pendingInsert,
      };
      rows.push(row);
      return { data: single ? row : [row], error: null };
    }
    const hit = rows.filter((r) => this.filters.every((f) => f(r)));
    if (this.patch) {
      if (this.patch.__delete) {
        db[this.table] = rows.filter((r) => !hit.includes(r));
      } else {
        for (const r of hit) Object.assign(r, this.patch);
      }
      return { data: single ? clone(hit[0]) : hit.map(clone), error: null };
    }
    return { data: single ? clone(hit[0]) : hit.map(clone), error: null, count: hit.length };
  }
}

export const fakeSupabase = { from: (table: string) => new Query(table) };

// --- "@/lib/assistant/actor" -------------------------------------------------
export async function cookieActor() {
  return { supabase: fakeSupabase, userId: OWNER, origin: "owner_session", job: null };
}
export async function serviceActor() {
  return { supabase: fakeSupabase, userId: OWNER, origin: "service", job: null };
}

// --- "@/lib/supabase/service": what the capture route builds ------------------
export function createServiceClient() {
  return fakeSupabase;
}

// --- "web-push": records every send; the test says how each endpoint answers -
export const push: {
  calls: { endpoint: string; payload: string }[];
  statusFor: Record<string, number>;
} = { calls: [], statusFor: {} };

async function sendNotification(sub: { endpoint: string }, payload?: string) {
  const status = push.statusFor[sub.endpoint] ?? 201;
  if (status >= 400) throw Object.assign(new Error("push service refused"), { statusCode: status });
  push.calls.push({ endpoint: sub.endpoint, payload: payload ?? "" });
  return { statusCode: status };
}
const webPush = { sendNotification };
export default webPush;

// --- everything else is a no-op ----------------------------------------------
const noop = async () => undefined;
export const withResourceAuth = noop;
export const createEvent = noop;
export const updateEvent = noop;
export const deleteAppEvent = noop;
export const addTripChecklist = noop;
export const addTripExpense = noop;
export const addTripLeg = noop;
export const createTrip = noop;
export const deleteTrip = noop;
export const deleteTripExpense = noop;
export const syncTripHotelStep = noop;
export const resolveJourneyId = noop;
export const updateTrip = noop;
export const updateTripExpense = noop;
export const removeFinanceReminder = noop;
export const removeObligationReminder = noop;
export const syncFinanceReminder = noop;
export const syncObligationReminder = noop;
export const syncTaskReminder = noop;
export const removeTaskReminder = noop;
export const mailRequest = () => async () => new Response("{}");
export const buildAppContext = async () => "";
export const loadActivePersonaRow = async () => null;
export const briefStoreFor = () => ({});
export const pdfText = async () => "";
export const runMailScan = noop;
