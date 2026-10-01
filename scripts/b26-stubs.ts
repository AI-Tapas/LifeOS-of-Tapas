// B26 test helper: an in-memory Supabase (just enough query surface for the
// task paths B26 touches) and no-op stand-ins for everything that would reach
// a mailbox, a calendar or a network. Synthetic data only. One module stands
// in for several "@/..." imports (see b26-loader.mjs).

type Row = Record<string, unknown>;

export const db: Record<string, Row[]> = {};
export function resetDb(): void {
  for (const k of Object.keys(db)) delete db[k];
  for (const t of ["tasks", "assistant_actions", "audit_log", "work_streams", "projects", "accounts"]) db[t] = [];
}
resetDb();

let seq = 0;
const OWNER = "user-1";

// A real client hands back copies, so a row read before a write is not changed
// by it. The tests rely on that (the undo snapshot).
const clone = (r: Row | undefined): Row | null => (r ? { ...r } : null);

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
  gte() { return this; }
  gt() { return this; }
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
      const row = { id: `${this.table}-${++seq}`, ...this.pendingInsert };
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
