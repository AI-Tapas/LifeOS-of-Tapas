// B33 test helper: an in-memory Supabase with just enough query surface for
// lib/events/sync.ts, and a Google stand-in that records every URL asked for.
// Synthetic data only.

type Row = Record<string, unknown>;

export const world = {
  tables: {} as Record<string, Row[]>,
  fetched: [] as string[],
};

export function reset(): void {
  world.tables = {};
  world.fetched = [];
}

class Query {
  private filters: ((r: Row) => boolean)[] = [];
  private mode: "select" | "upsert" | "update" | "delete" = "select";
  private payload: Row | Row[] = {};
  private onConflict = "";
  private table: string;
  constructor(table: string) {
    this.table = table;
  }
  select() { return this; }
  eq(c: string, v: unknown) { this.filters.push((r) => r[c] === v); return this; }
  in(c: string, v: unknown[]) { this.filters.push((r) => v.includes(r[c])); return this; }
  update(p: Row) { this.mode = "update"; this.payload = p; return this; }
  delete() { this.mode = "delete"; return this; }
  upsert(p: Row[], o: { onConflict: string }) {
    this.mode = "upsert"; this.payload = p; this.onConflict = o.onConflict; return this;
  }
  then(res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) {
    return Promise.resolve(this.run()).then(res, rej);
  }
  private run() {
    const rows = (world.tables[this.table] ??= []);
    if (this.mode === "upsert") {
      const keys = this.onConflict.split(",");
      for (const p of this.payload as Row[]) {
        const hit = rows.find((r) => keys.every((k) => r[k] === p[k]));
        if (hit) Object.assign(hit, p);
        else rows.push({ id: `${this.table}-${rows.length + 1}`, ...p });
      }
      return { data: null, error: null };
    }
    const hit = rows.filter((r) => this.filters.every((f) => f(r)));
    if (this.mode === "update") for (const r of hit) Object.assign(r, this.payload);
    if (this.mode === "delete") world.tables[this.table] = rows.filter((r) => !hit.includes(r));
    return { data: hit, error: null };
  }
}

// "@/lib/supabase/service"
export function createServiceClient() {
  return { from: (t: string) => new Query(t) };
}

// "@/lib/oauth/tokens": run the caller's request with a dummy token. The test
// replaces globalThis.fetch, so no request leaves the process.
export async function withResourceAuth<T>(
  _accountId: string,
  fn: (token: string) => Promise<T>
): Promise<T> {
  return fn("test-token");
}

// "@/lib/reminders/writer"
export async function retryPendingReminders(): Promise<void> {}
