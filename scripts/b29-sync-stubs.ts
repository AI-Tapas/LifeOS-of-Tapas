// B29 test helper: an in-memory Supabase that can be told to fail a read, and a
// Google stand-in that only counts calls. Synthetic data only.

type Row = Record<string, unknown>;

export const world = {
  tables: {} as Record<string, Row[]>,
  // table name -> read fails with this error
  failRead: new Set<string>(),
  google: [] as string[],
};

export function reset(): void {
  world.tables = {};
  world.failRead = new Set();
  world.google = [];
}

class Query {
  private filters: ((r: Row) => boolean)[] = [];
  private mode: "select" | "insert" | "update" | "delete" = "select";
  private payload: Row = {};
  private table: string;
  constructor(table: string) {
    this.table = table;
  }
  select() { return this; }
  eq(c: string, v: unknown) { this.filters.push((r) => r[c] === v); return this; }
  neq(c: string, v: unknown) { this.filters.push((r) => r[c] !== v); return this; }
  insert(p: Row) { this.mode = "insert"; this.payload = p; return this; }
  update(p: Row) { this.mode = "update"; this.payload = p; return this; }
  delete() { this.mode = "delete"; return this; }
  maybeSingle() { return Promise.resolve(this.run(true)); }
  then(res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) {
    return Promise.resolve(this.run(false)).then(res, rej);
  }
  private run(single: boolean) {
    const rows = (world.tables[this.table] ??= []);
    if (this.mode === "select" && world.failRead.has(this.table)) {
      return { data: null, error: { message: "boom" } };
    }
    if (this.mode === "insert") {
      rows.push({ id: `${this.table}-${rows.length + 1}`, ...this.payload });
      return { data: null, error: null };
    }
    const hit = rows.filter((r) => this.filters.every((f) => f(r)));
    if (this.mode === "update") for (const r of hit) Object.assign(r, this.payload);
    if (this.mode === "delete") world.tables[this.table] = rows.filter((r) => !hit.includes(r));
    return { data: single ? (hit[0] ?? null) : hit, error: null };
  }
}

export function createServiceClient() {
  return { from: (t: string) => new Query(t) };
}

// "@/lib/reminders/writer": every Google call is recorded, none is made.
export async function gcalCreate(): Promise<string> {
  world.google.push("create");
  return "ext-new";
}
export async function gcalPatch(): Promise<boolean> {
  world.google.push("patch");
  return true;
}
export async function gcalDelete(): Promise<void> {
  world.google.push("delete");
}
